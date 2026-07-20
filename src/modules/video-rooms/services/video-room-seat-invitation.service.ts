import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { VideoRoomInvitation, VideoRoomInvitationStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { VIDEO_ROOM_INVITATION_TTL_SECONDS } from '../constants/video-room.constants';
import type { VideoRoomInvitationView } from '../entities/video-room-stage.view';
import {
  SeatInvitationResolvedEvent,
  SeatInvitationSentEvent,
} from '../events/video-room-seat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { toVideoRoomInvitationView } from '../mappers/video-room-stage.mapper';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
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
    const pending = await this.seats.listPendingInvitations(roomId, inviteeUserId);
    if (pending.some((p) => (p.seatIndex ?? null) === (seatIndex ?? null))) {
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
      }),
    );
    return toVideoRoomInvitationView(inv);
  }

  /** Accept an invitation (invitee only) → take the seat. */
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
    const seatIndex = inv.seatIndex ?? (await this.seatSvc.findOpenSeat(actor, roomId));
    const view = await this.seatSvc.seatUser(roomId, actor.id, actor.id, seatIndex, ip);
    await this.seats.setInvitationStatus(inv.id, VideoRoomInvitationStatus.ACCEPTED, actor.id);
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
    if (inv.status !== VideoRoomInvitationStatus.PENDING) {
      throw new BusinessException(
        ERROR_CODES.SEAT_INVITATION_NOT_FOUND,
        'Invitation is no longer pending.',
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
