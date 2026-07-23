import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  VideoRoomInvitation,
  VideoRoomInvitationStatus,
  VideoRoomInvitationType,
  VideoRoomSeatStatus,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { canTransitionInvitation } from '../constants/video-room-seat-workflow';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  VIDEO_ROOM_INVITATION_MAX_ATTEMPTS,
  VIDEO_ROOM_INVITATION_TTL_SECONDS,
} from '../constants/video-room.constants';
import type { SeatStageView } from '../entities/video-room-seat-stage.view';
import type { VideoRoomInvitationView } from '../entities/video-room-stage.view';
import {
  SeatInvitationDeliveredEvent,
  SeatInvitationResolvedEvent,
  SeatInvitationSentEvent,
} from '../events/video-room-seat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { toVideoRoomInvitationView } from '../mappers/video-room-stage.mapper';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomSeatService } from './video-room-seat.service';

/**
 * Seat invitation workflow (VR-4): owner/admin invite a user onto a (specific or any)
 * seat; the invitee accepts or rejects; the inviter may cancel. One active invitation
 * per (room, invitee, seat). A pending invite surfaces as the INVITED display status
 * (derived overlay) without hard-holding the seat — acceptance seats the invitee
 * through the shared `VideoRoomSeatService.seatUser` pipeline.
 */
@Injectable()
export class VideoRoomSeatInvitationService {
  constructor(
    private readonly seatSvc: VideoRoomSeatService,
    private readonly seats: VideoRoomSeatsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly events: VideoRoomEventsRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly rooms: VideoRoomsRepository,
  ) {}

  /** Invite a user onto a seat (owner/admin). */
  async invite(
    actor: RoomActor,
    roomId: string,
    inviteeUserId: string,
    seatIndex?: number,
    ip?: string,
  ): Promise<VideoRoomInvitationView> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.INVITE_USERS);

    // VR-8 — the invitee must be an active member, unseated, and unblocked.
    const member = await this.rooms.getMember(roomId, inviteeUserId);
    if (!member?.isActive) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'That user is not an active member of this room.',
        HttpStatus.CONFLICT,
      );
    }
    if (await this.seats.findOccupiedSeat(roomId, inviteeUserId)) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_ON_SEAT,
        'That user already holds a seat.',
        HttpStatus.CONFLICT,
      );
    }
    if (await this.moderation.isActivelyBlocked(roomId, inviteeUserId)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_BLOCKED,
        'That user is blocked from this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    // VR-8 — when a specific seat is named, it must exist and be takeable.
    if (seatIndex !== undefined) {
      const seat = await this.seats.findSeat(roomId, seatIndex);
      if (!seat) {
        throw new BusinessException(
          ERROR_CODES.SEAT_NOT_FOUND,
          'That seat does not exist in this room.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (seat.isLocked) {
        throw new BusinessException(
          ERROR_CODES.SEAT_LOCKED,
          'That seat is locked.',
          HttpStatus.CONFLICT,
        );
      }
      if (seat.seatStatus === VideoRoomSeatStatus.RESERVED) {
        throw new BusinessException(
          ERROR_CODES.SEAT_RESERVED,
          'That seat is reserved.',
          HttpStatus.CONFLICT,
        );
      }
      if (seat.seatStatus === VideoRoomSeatStatus.OCCUPIED) {
        throw new BusinessException(
          ERROR_CODES.SEAT_TAKEN,
          'That seat is already occupied.',
          HttpStatus.CONFLICT,
        );
      }
    }

    const pending = await this.seats.listPendingInvitations(roomId, inviteeUserId);
    if (
      pending
        .filter((p) => p.type !== VideoRoomInvitationType.ROOM)
        .some((p) => (p.seatIndex ?? null) === (seatIndex ?? null))
    ) {
      throw new BusinessException(
        ERROR_CODES.DUPLICATE_SEAT_INVITATION,
        'That user already has a pending invitation for this seat.',
        HttpStatus.CONFLICT,
      );
    }
    const expiresAt = new Date(Date.now() + VIDEO_ROOM_INVITATION_TTL_SECONDS * 1000);
    const inv = await this.seats.createInvitation(
      { roomId, inviterId: actor.id, inviteeUserId, seatIndex: seatIndex ?? null, expiresAt },
      actor.id,
    );
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.invitation_sent',
      payload: {
        invitationId: inv.id,
        inviteeUserId,
        seatIndex: seatIndex ?? null,
        ...(ip ? { ip } : {}),
      },
    });
    await this.bus.publish(
      new SeatInvitationSentEvent({
        roomId,
        invitationId: inv.id,
        inviterId: actor.id,
        inviteeUserId,
        seatIndex: seatIndex ?? null,
        expiresAt: expiresAt.toISOString(),
        type: inv.type,
      }),
    );
    return toVideoRoomInvitationView(inv);
  }

  /**
   * Accept an invitation (invitee only) → take the seat.
   *
   * I6 — deliberately NOT CAS-guarded, unlike `VideoRoomSeatRequestService`'s
   * `driveSeating`. That method has a distinct in-flight ACCEPTED state
   * written *before* `seatUser` is even called, so guarding it stops a second
   * caller before it ever seats anyone. Invitations have no such
   * intermediate — ACCEPTED is both "seating in flight" and "done" — so a
   * symmetric guard on the terminal ACCEPTED/FAILED writes here would risk
   * telling the legitimately-seated caller they lost a race they actually
   * won (whichever write reaches Postgres second would see a row that no
   * longer matches its own read, even when that write is the correct one).
   * The realistic trigger — the SAME invitee double-submitting their own
   * accept — is narrower than the multi-admin request race this ticket
   * fixes; closing it properly needs a real in-flight status, which is a
   * schema change out of scope here. `retry()` above, which shares this
   * seating pipeline, IS guarded, since its FAILED → PENDING write has no
   * such asymmetry risk.
   */
  async accept(actor: RoomActor, roomId: string, invitationId: string, ip?: string) {
    await this.seatSvc.requireLiveRoom(roomId);
    const inv = await this.requirePendingInvitation(roomId, invitationId, actor.id);
    if (inv.inviteeUserId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Only the invited user may accept this invitation.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (inv.type === VideoRoomInvitationType.ROOM) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
        'That invitation is a room invitation; use the room-invitation endpoints.',
        HttpStatus.CONFLICT,
      );
    }
    const seatIndex = inv.seatIndex ?? (await this.seatSvc.findOpenSeat(actor, roomId));

    let view: SeatStageView;
    try {
      view = await this.seatSvc.seatUser(roomId, actor.id, actor.id, seatIndex, ip);
    } catch (err) {
      // A transient infra error (lock-acquisition failure, Redis/Postgres blip)
      // must not burn the invitation's attempt budget — only a genuine business
      // rejection counts as a failed attempt.
      if (!(err instanceof BusinessException)) throw err;
      // VR-8 — seating threw: mark FAILED (bounded retry lives on `retry`) and rethrow so
      // the caller never sees a silent success.
      const message = (err as Error).message;
      await this.seats.setInvitationStatus(inv.id, VideoRoomInvitationStatus.FAILED, actor.id, {
        bumpAttempt: true,
        lastError: message,
      });
      await this.events.appendEvent({
        roomId,
        actorId: actor.id,
        eventType: 'seat.invitation_failed',
        payload: { invitationId: inv.id, reason: message, ...(ip ? { ip } : {}) },
      });
      await this.bus.publish(
        new SeatInvitationResolvedEvent({
          roomId,
          invitationId: inv.id,
          inviteeUserId: actor.id,
          status: 'FAILED',
        }),
      );
      throw err;
    }

    await this.seats.setInvitationStatus(inv.id, VideoRoomInvitationStatus.ACCEPTED, actor.id, {
      bumpAttempt: true,
      lastError: null,
    });
    await this.bus.publish(
      new SeatInvitationResolvedEvent({
        roomId,
        invitationId: inv.id,
        inviteeUserId: actor.id,
        status: 'ACCEPTED',
        version: view.version,
        seatIndex,
      }),
    );
    return view;
  }

  /** Reject an invitation (invitee only). */
  async reject(actor: RoomActor, roomId: string, invitationId: string, ip?: string): Promise<void> {
    await this.seatSvc.requireLiveRoom(roomId);
    const inv = await this.requirePendingInvitation(roomId, invitationId, actor.id);
    if (inv.inviteeUserId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Only the invited user may reject this invitation.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (inv.type === VideoRoomInvitationType.ROOM) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
        'That invitation is a room invitation; use the room-invitation endpoints.',
        HttpStatus.CONFLICT,
      );
    }
    await this.seats.setInvitationStatus(inv.id, VideoRoomInvitationStatus.REJECTED, actor.id);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.invitation_rejected',
      payload: { invitationId: inv.id, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatInvitationResolvedEvent({
        roomId,
        invitationId: inv.id,
        inviteeUserId: actor.id,
        status: 'REJECTED',
      }),
    );
  }

  /** Cancel an outstanding invitation (inviter / owner / admin). */
  async cancel(actor: RoomActor, roomId: string, invitationId: string, ip?: string): Promise<void> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.INVITE_USERS);
    const inv = await this.requirePendingInvitation(roomId, invitationId, actor.id);
    await this.seats.setInvitationStatus(inv.id, VideoRoomInvitationStatus.CANCELLED, actor.id);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.invitation_cancelled',
      payload: { invitationId: inv.id, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatInvitationResolvedEvent({
        roomId,
        invitationId: inv.id,
        inviteeUserId: inv.inviteeUserId,
        status: 'CANCELLED',
      }),
    );
  }

  /**
   * The invitee's client confirms it received the invitation → DELIVERED.
   * Idempotent: acknowledging twice is a no-op, so a client that retries its ack
   * after a flaky socket does not produce a second event.
   */
  async acknowledge(
    actor: RoomActor,
    roomId: string,
    invitationId: string,
    ip?: string,
  ): Promise<VideoRoomInvitationView> {
    await this.seatSvc.requireLiveRoom(roomId);
    const inv = await this.requirePendingInvitation(roomId, invitationId, actor.id);
    if (inv.inviteeUserId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Only the invited user may acknowledge this invitation.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (inv.status === VideoRoomInvitationStatus.DELIVERED) {
      return toVideoRoomInvitationView(inv);
    }

    const deliveredAt = new Date();
    const updated = await this.seats.setInvitationStatus(
      inv.id,
      VideoRoomInvitationStatus.DELIVERED,
      actor.id,
      { deliveredAt },
    );
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.invitation_delivered',
      payload: { invitationId: inv.id, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatInvitationDeliveredEvent({
        roomId,
        invitationId: inv.id,
        inviteeUserId: actor.id,
        deliveredAt: deliveredAt.toISOString(),
      }),
    );
    return toVideoRoomInvitationView(updated);
  }

  /** Re-drive a FAILED invitation's seating (invitee only), bounded by attemptCount. */
  async retry(
    actor: RoomActor,
    roomId: string,
    invitationId: string,
    ip?: string,
  ): Promise<SeatStageView> {
    await this.seatSvc.requireLiveRoom(roomId);
    const inv = await this.seats.findInvitationById(invitationId);
    if (!inv || inv.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.SEAT_INVITATION_NOT_FOUND,
        'Invitation not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (inv.inviteeUserId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Only the invited user may retry this invitation.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!canTransitionInvitation(inv.status, VideoRoomInvitationStatus.PENDING)) {
      throw new BusinessException(
        ERROR_CODES.SEAT_INVITATION_INVALID_TRANSITION,
        `An invitation in state ${inv.status} cannot be retried.`,
        HttpStatus.CONFLICT,
      );
    }
    if (inv.attemptCount >= VIDEO_ROOM_INVITATION_MAX_ATTEMPTS) {
      throw new BusinessException(
        ERROR_CODES.SEAT_RETRY_EXHAUSTED,
        `This invitation has already used all ${VIDEO_ROOM_INVITATION_MAX_ATTEMPTS} seating attempts.`,
        HttpStatus.CONFLICT,
      );
    }

    // I6 — CAS'd on the FAILED this just read: two concurrent retries of the
    // same invitation (a double-click/duplicate-submit — retry is
    // invitee-only, so this can't be two different actors) must not both
    // proceed into `accept()`. The loser gets a clean CONFLICT here instead
    // of racing the winner's `seatUser` call.
    const updated = await this.seats.setInvitationStatus(
      inv.id,
      VideoRoomInvitationStatus.PENDING,
      actor.id,
      { lastError: null, expectedFrom: inv.status },
    );
    if (!updated) {
      throw new BusinessException(
        ERROR_CODES.SEAT_INVITATION_INVALID_TRANSITION,
        `Invitation ${inv.id} is no longer ${inv.status}; another actor already resolved it.`,
        HttpStatus.CONFLICT,
      );
    }
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.invitation_retried',
      payload: { invitationId: inv.id, attempt: inv.attemptCount + 1, ...(ip ? { ip } : {}) },
    });
    return this.accept(actor, roomId, inv.id, ip);
  }

  /** Outstanding invitations for the room (owner/admin; INVITE_USERS). */
  async listInvitations(actor: RoomActor, roomId: string): Promise<VideoRoomInvitationView[]> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.INVITE_USERS);
    const rows = await this.seats.listPendingInvitations(roomId);
    return rows.map(toVideoRoomInvitationView);
  }

  // ---- Room invitations (VR-15) ----

  /**
   * VR-15 — invite a NON-member into the room (private-room invitation). Distinct
   * from seat invitations: no seat, invitee need not be a member. Emitting
   * SeatInvitationSentEvent with type ROOM fires the ROOM_INVITATION notification.
   */
  async inviteToRoom(
    actor: RoomActor,
    roomId: string,
    inviteeUserId: string,
    ip?: string,
  ): Promise<VideoRoomInvitationView> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.INVITE_USERS);

    const member = await this.rooms.getMember(roomId, inviteeUserId);
    if (member?.isActive) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
        'That user is already in this room.',
        HttpStatus.CONFLICT,
      );
    }
    const existing = await this.seats.findActiveRoomInvitation(roomId, inviteeUserId);
    if (existing) {
      throw new BusinessException(
        ERROR_CODES.DUPLICATE_SEAT_INVITATION,
        'That user already has a pending room invitation.',
        HttpStatus.CONFLICT,
      );
    }

    const expiresAt = new Date(Date.now() + VIDEO_ROOM_INVITATION_TTL_SECONDS * 1000);
    const inv = await this.seats.createInvitation(
      {
        roomId,
        inviterId: actor.id,
        inviteeUserId,
        type: VideoRoomInvitationType.ROOM,
        seatIndex: null,
        expiresAt,
      },
      actor.id,
    );
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'room.invitation_sent',
      payload: { invitationId: inv.id, inviteeUserId, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatInvitationSentEvent({
        roomId,
        invitationId: inv.id,
        inviterId: actor.id,
        inviteeUserId,
        seatIndex: null,
        expiresAt: expiresAt.toISOString(),
        type: inv.type,
      }),
    );
    return toVideoRoomInvitationView(inv);
  }

  /** Accept a ROOM invitation (invitee only). Marks ACCEPTED — while the invitation
   * is still within its TTL, the invitee's join() bypasses the private-room password
   * (see member service + hasActiveRoomInvitation's expiry bound). Does not seat/join. */
  async acceptRoomInvite(
    actor: RoomActor,
    roomId: string,
    invitationId: string,
    ip?: string,
  ): Promise<void> {
    await this.seatSvc.requireLiveRoom(roomId);
    const inv = await this.requirePendingInvitation(roomId, invitationId, actor.id);
    if (inv.inviteeUserId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Only the invited user may accept this invitation.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (inv.type !== VideoRoomInvitationType.ROOM) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
        'That invitation is not a room invitation.',
        HttpStatus.CONFLICT,
      );
    }
    await this.seats.setInvitationStatus(inv.id, VideoRoomInvitationStatus.ACCEPTED, actor.id, {
      bumpAttempt: true,
      lastError: null,
    });
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'room.invitation_accepted',
      payload: { invitationId: inv.id, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatInvitationResolvedEvent({
        roomId,
        invitationId: inv.id,
        inviteeUserId: actor.id,
        status: 'ACCEPTED',
      }),
    );
  }

  /** Reject a ROOM invitation (invitee only). */
  async rejectRoomInvite(
    actor: RoomActor,
    roomId: string,
    invitationId: string,
    ip?: string,
  ): Promise<void> {
    await this.seatSvc.requireLiveRoom(roomId);
    const inv = await this.requirePendingInvitation(roomId, invitationId, actor.id);
    if (inv.inviteeUserId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Only the invited user may reject this invitation.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (inv.type !== VideoRoomInvitationType.ROOM) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
        'That invitation is not a room invitation.',
        HttpStatus.CONFLICT,
      );
    }
    await this.seats.setInvitationStatus(inv.id, VideoRoomInvitationStatus.REJECTED, actor.id);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'room.invitation_rejected',
      payload: { invitationId: inv.id, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatInvitationResolvedEvent({
        roomId,
        invitationId: inv.id,
        inviteeUserId: actor.id,
        status: 'REJECTED',
      }),
    );
  }

  // ---- Internal ----

  private async requirePendingInvitation(
    roomId: string,
    invitationId: string,
    actorId: string,
  ): Promise<VideoRoomInvitation> {
    const inv = await this.seats.findInvitationById(invitationId);
    if (!inv || inv.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.SEAT_INVITATION_NOT_FOUND,
        'Invitation not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    // VR-8 — DELIVERED is an acknowledged-but-still-actionable state: accept/reject/
    // cancel must work from either PENDING or DELIVERED.
    const actionable: VideoRoomInvitationStatus[] = [
      VideoRoomInvitationStatus.PENDING,
      VideoRoomInvitationStatus.DELIVERED,
    ];
    if (!actionable.includes(inv.status)) {
      throw new BusinessException(
        ERROR_CODES.SEAT_INVITATION_NOT_FOUND,
        'Invitation is no longer actionable.',
        HttpStatus.CONFLICT,
      );
    }
    if (inv.expiresAt.getTime() < Date.now()) {
      await this.seats.setInvitationStatus(inv.id, VideoRoomInvitationStatus.EXPIRED, actorId);
      throw new BusinessException(
        ERROR_CODES.SEAT_INVITATION_EXPIRED,
        'Invitation has expired.',
        HttpStatus.CONFLICT,
      );
    }
    return inv;
  }
}
