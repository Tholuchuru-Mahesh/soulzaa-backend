import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AudioRoom,
  RoomMemberRole,
  RoomSeat,
  SeatHistoryAction,
  SeatInvitationStatus,
  SeatRequestStatus,
  SeatType,
} from '@prisma/client';
import { MAX_AUDIO_SEATS } from 'src/common/constants/room.constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { OWNER_SEAT_INDEX, roomSeatLockKey } from '../constants/audio-room.constants';
import { RoomPermission } from '../constants/room-permissions';
import type { GrantableRole } from '../dto/grant-role.dto';
import {
  PremiumSeatPurchaseRequestedEvent,
  SeatAcceptedEvent,
  SeatJoinedEvent,
  SeatLeftEvent,
  SeatLockedEvent,
  SeatRejectedEvent,
  SeatRequestedEvent,
  SeatUnlockedEvent,
  SeatUpdatedEvent,
  type SeatUpdateReason,
} from '../events/audio-room-seat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import {
  AudioRoomSeatsRepository,
  type StageSnapshot,
} from '../repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { RoomPermissionService } from './room-permission.service';

/**
 * The AR-1 seat & role command surface. Every mutation asserts the room is LIVE,
 * the actor is an active member, and the actor holds the required permission
 * (RoomPermissionService); seat claims run under a per-room distributed lock;
 * each change appends an immutable seat_history row, refreshes the Redis stage
 * snapshot, and publishes a domain event that the socket listener bridges to a
 * `seat.*` broadcast. The DB is authoritative; Redis is a read-through cache.
 */
@Injectable()
export class AudioRoomSeatsService {
  private readonly stageTtl: number;
  private readonly invitationTtlSeconds: number;

  constructor(
    private readonly rooms: AudioRoomsRepository,
    private readonly seats: AudioRoomSeatsRepository,
    private readonly permissions: RoomPermissionService,
    private readonly locks: LockService,
    private readonly config: ConfigService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {
    const cfg = this.config.get('audioRoom') as {
      cacheTtlSeconds: number | string;
      seatInvitationTtlSeconds: number | string;
    };
    this.stageTtl = Number(cfg.cacheTtlSeconds);
    this.invitationTtlSeconds = Number(cfg.seatInvitationTtlSeconds);
  }

  // ======================= Queries =======================

  async getStage(roomId: string): Promise<StageSnapshot> {
    await this.assertRoomExists(roomId);
    const cached = await this.seats.getCachedStage(roomId);
    if (cached) return cached;
    return this.rebuildStage(roomId);
  }

  async getQueue(roomId: string): Promise<Array<{ userId: string; position: number }>> {
    await this.assertRoomExists(roomId);
    const entries = await this.seats.listQueue(roomId);
    return entries.map((e) => ({ userId: e.userId, position: e.position }));
  }

  async listPendingRequests(roomId: string) {
    await this.assertRoomExists(roomId);
    return this.seats.listPendingRequests(roomId);
  }

  async isRoomMuted(roomId: string): Promise<boolean> {
    const settings = await this.seats.getSettings(roomId);
    return settings?.isRoomMuted ?? false;
  }

  async isSeatMuted(roomId: string, userId: string): Promise<boolean> {
    const seat = await this.seats.getSeatByOccupant(roomId, userId);
    return seat?.isMuted ?? false;
  }

  // ======================= Layout =======================

  async configureLayout(
    actor: RoomActor,
    roomId: string,
    dto: {
      speakerSeatCount?: number;
      premiumAdminSeatCount?: number;
      requireApprovalForSeat?: boolean;
      metadata?: { preset?: string; seatOrder?: number[]; disabledSeats?: number[] };
    },
  ): Promise<StageSnapshot> {
    await this.assertLiveRoom(roomId);
    await this.permissions.assertPermission(roomId, actor, RoomPermission.MANAGE_SEATS);
    const settings = await this.requireSettings(roomId);

    const speaker = dto.speakerSeatCount ?? settings.speakerSeatCount;
    const premium = dto.premiumAdminSeatCount ?? settings.premiumAdminSeatCount;
    if (1 + speaker + premium > MAX_AUDIO_SEATS) {
      throw new BusinessException(
        ERROR_CODES.SEAT_LAYOUT_INVALID,
        `A room can have at most ${MAX_AUDIO_SEATS} seats including the owner seat.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const disabledSeats = new Set<number>(dto.metadata?.disabledSeats ?? []);

    await this.locks.withLock(roomSeatLockKey(roomId), async () => {
      const { displaced } = await this.seats.reconfigureLayoutTx(
        roomId,
        premium,
        speaker,
        actor.id,
      );
      if (dto.requireApprovalForSeat !== undefined) {
        await this.seats.setRequireApprovalForSeat(roomId, dto.requireApprovalForSeat);
      }
      for (const userId of displaced) {
        await this.seats.appendSeatHistory({
          roomId,
          actorId: actor.id,
          subjectUserId: userId,
          action: SeatHistoryAction.SPEAKER_REMOVED,
        });
      }

      // Apply individual seat lock states based on disabledSeats.
      if (dto.metadata?.disabledSeats !== undefined) {
        const currentSeats = await this.seats.listSeats(roomId);
        const lockMap = new Map<number, boolean>();
        for (const seat of currentSeats) {
          if (seat.seatIndex === 0) continue; // Owner seat is never locked.
          const shouldLock = disabledSeats.has(seat.seatIndex);
          lockMap.set(seat.seatIndex, shouldLock);
          // If a seat is being disabled and it is occupied, displace the occupant.
          if (shouldLock && seat.occupantUserId) {
            await this.seats.setOccupant(roomId, seat.seatIndex, null, actor.id);
            await this.seats.appendSeatHistory({
              roomId,
              actorId: actor.id,
              subjectUserId: seat.occupantUserId,
              action: SeatHistoryAction.SPEAKER_REMOVED,
              seatIndex: seat.seatIndex,
            });
          }
        }
        await this.seats.setSeatsLocked(roomId, lockMap, actor.id);
      }

      // Persist metadata (preset, seatOrder, disabledSeats) for future stage loads.
      if (dto.metadata) {
        await this.seats.setMetadata(roomId, dto.metadata as Record<string, unknown>);
      }
    });

    await this.seats.appendSeatHistory({
      roomId,
      actorId: actor.id,
      action: SeatHistoryAction.LAYOUT_CHANGED,
      metadata: { speakerSeatCount: speaker, premiumAdminSeatCount: premium },
    });
    await this.publishUpdate(roomId, actor.id, 'layout_changed');
    return this.rebuildStage(roomId);
  }

  // ======================= Requests =======================

  async requestSeat(
    actor: RoomActor,
    roomId: string,
    dto: { seatIndex?: number; type?: string },
  ): Promise<{ status: 'seated' | 'queued'; seatIndex: number | null; position: number | null }> {
    await this.assertLiveRoom(roomId);
    await this.assertActiveMember(roomId, actor.id);

    return this.locks.withLock(roomSeatLockKey(roomId), async () => {
      const requestType = dto.type || 'BECOME_SPEAKER';
      if (requestType === 'BECOME_SPEAKER') {
        if (await this.seats.getSeatByOccupant(roomId, actor.id)) {
          throw this.err(
            ERROR_CODES.ALREADY_ON_SEAT,
            'You are already on a seat.',
            HttpStatus.CONFLICT,
          );
        }
      }
      if (await this.seats.findPendingRequestByUser(roomId, actor.id, requestType)) {
        throw this.err(
          ERROR_CODES.SEAT_REQUEST_EXISTS,
          'You already have a pending seat request.',
          HttpStatus.CONFLICT,
        );
      }

      const settings = await this.requireSettings(roomId);
      const request = await this.seats.createRequest(
        roomId,
        actor.id,
        dto.seatIndex ?? null,
        requestType,
        actor.id,
      );
      await this.seats.appendSeatHistory({
        roomId,
        actorId: actor.id,
        action: SeatHistoryAction.REQUEST_CREATED,
        seatIndex: dto.seatIndex ?? null,
      });

      // Auto-accept when approval is off, a suitable seat is free, and the type is BECOME_SPEAKER.
      if (requestType === 'BECOME_SPEAKER' && !settings.requireApprovalForSeat) {
        const seat = await this.findOpenSeatFor(roomId, actor.id, dto.seatIndex ?? null);
        if (seat) {
          await this.occupy(roomId, seat, actor.id, actor.id);
          await this.seats.resolveRequest(request.id, SeatRequestStatus.ACCEPTED, actor.id);
          await this.seats.appendSeatHistory({
            roomId,
            actorId: actor.id,
            action: SeatHistoryAction.REQUEST_ACCEPTED,
            seatIndex: seat.seatIndex,
          });
          await this.bus.publish(
            new SeatJoinedEvent({ roomId, userId: actor.id, seatIndex: seat.seatIndex }),
          );
          await this.rebuildStage(roomId);
          return { status: 'seated' as const, seatIndex: seat.seatIndex, position: null };
        }
      }

      const entry = await this.seats.enqueue(roomId, actor.id, request.id);
      await this.bus.publish(
        new SeatRequestedEvent({
          roomId,
          userId: actor.id,
          requestId: request.id,
          seatIndex: dto.seatIndex ?? null,
          queuePosition: entry.position,
          type: requestType,
        }),
      );
      await this.rebuildStage(roomId);
      return { status: 'queued' as const, seatIndex: null, position: entry.position };
    });
  }

  async cancelRequest(actor: RoomActor, roomId: string, type?: string): Promise<void> {
    await this.assertLiveRoom(roomId);
    const requests = await this.seats.findPendingRequestsByUser(roomId, actor.id, type);
    if (requests.length === 0) {
      throw this.err(
        ERROR_CODES.SEAT_REQUEST_NOT_FOUND,
        'You have no pending seat request.',
        HttpStatus.NOT_FOUND,
      );
    }
    for (const request of requests) {
      await this.seats.resolveRequest(request.id, SeatRequestStatus.CANCELLED, actor.id);
      await this.seats.appendSeatHistory({
        roomId,
        actorId: actor.id,
        action: SeatHistoryAction.REQUEST_CANCELLED,
      });
    }
    const remaining = await this.seats.findPendingRequestsByUser(roomId, actor.id);
    if (remaining.length === 0) {
      await this.seats.dequeue(roomId, actor.id);
    }
    await this.publishUpdate(roomId, actor.id, 'request_cancelled', null, actor.id);
    await this.rebuildStage(roomId);
  }

  async resolveRequest(
    actor: RoomActor,
    roomId: string,
    requestId: string,
    accept: boolean,
  ): Promise<void> {
    await this.assertLiveRoom(roomId);
    await this.permissions.assertPermission(roomId, actor, RoomPermission.MANAGE_SEATS);
    const request = await this.seats.getRequest(requestId);
    if (!request || request.roomId !== roomId || request.status !== SeatRequestStatus.PENDING) {
      throw this.err(
        ERROR_CODES.SEAT_REQUEST_NOT_FOUND,
        'Seat request not found or already resolved.',
        HttpStatus.NOT_FOUND,
      );
    }

    if (!accept) {
      await this.seats.resolveRequest(requestId, SeatRequestStatus.REJECTED, actor.id);
      await this.seats.dequeue(roomId, request.userId);
      await this.seats.appendSeatHistory({
        roomId,
        actorId: actor.id,
        subjectUserId: request.userId,
        action: SeatHistoryAction.REQUEST_REJECTED,
      });
      await this.bus.publish(
        new SeatRejectedEvent({ roomId, userId: request.userId, requestId, actorId: actor.id }),
      );
      await this.rebuildStage(roomId);
      return;
    }

    await this.locks.withLock(roomSeatLockKey(roomId), async () => {
      const requestType = request.type || 'BECOME_SPEAKER';
      if (requestType === 'REQUEST_TO_SPEAK') {
        // REQUEST_TO_SPEAK flow: grant temporary speaking permission
        await this.rooms.setTempSpeakAllowed(roomId, request.userId, true);
        await this.seats.resolveRequest(requestId, SeatRequestStatus.ACCEPTED, actor.id);
        await this.seats.dequeue(roomId, request.userId);
        await this.seats.appendSeatHistory({
          roomId,
          actorId: actor.id,
          subjectUserId: request.userId,
          action: SeatHistoryAction.REQUEST_ACCEPTED,
          metadata: { type: 'REQUEST_TO_SPEAK' },
        });
        await this.bus.publish(
          new SeatAcceptedEvent({
            roomId,
            userId: request.userId,
            requestId,
            actorId: actor.id,
            seatIndex: null,
          }),
        );
        await this.publishUpdate(roomId, actor.id, 'temp_speak_granted', null, request.userId);
        return;
      }

      // BECOME_SPEAKER flow: occupy first available speaker seat
      const seat = await this.findOpenSeatFor(roomId, request.userId, request.seatIndex);
      if (!seat) {
        throw this.err(
          ERROR_CODES.SEAT_FULL,
          'No suitable seat is available.',
          HttpStatus.CONFLICT,
        );
      }
      await this.occupy(roomId, seat, request.userId, actor.id);
      await this.seats.resolveRequest(requestId, SeatRequestStatus.ACCEPTED, actor.id);
      await this.seats.dequeue(roomId, request.userId);
      await this.seats.appendSeatHistory({
        roomId,
        actorId: actor.id,
        subjectUserId: request.userId,
        action: SeatHistoryAction.REQUEST_ACCEPTED,
        seatIndex: seat.seatIndex,
      });
      await this.bus.publish(
        new SeatAcceptedEvent({
          roomId,
          userId: request.userId,
          requestId,
          actorId: actor.id,
          seatIndex: seat.seatIndex,
        }),
      );
      await this.bus.publish(
        new SeatJoinedEvent({ roomId, userId: request.userId, seatIndex: seat.seatIndex }),
      );
    });
    await this.rebuildStage(roomId);
  }

  // ======================= Invitations =======================

  async invite(
    actor: RoomActor,
    roomId: string,
    dto: { userId: string; seatIndex?: number },
  ): Promise<{ invitationId: string; expiresAt: Date }> {
    await this.assertLiveRoom(roomId);
    await this.permissions.assertPermission(roomId, actor, RoomPermission.MANAGE_SEATS);
    await this.assertActiveMember(roomId, dto.userId);
    if (dto.seatIndex !== undefined) await this.requireSeat(roomId, dto.seatIndex);

    const expiresAt = new Date(Date.now() + this.invitationTtlSeconds * 1000);
    const invitation = await this.seats.createInvitation({
      roomId,
      inviterId: actor.id,
      inviteeUserId: dto.userId,
      seatIndex: dto.seatIndex ?? null,
      expiresAt,
    });
    await this.seats.appendSeatHistory({
      roomId,
      actorId: actor.id,
      subjectUserId: dto.userId,
      action: SeatHistoryAction.INVITE_SENT,
      seatIndex: dto.seatIndex ?? null,
    });
    await this.publishUpdate(roomId, actor.id, 'invited', dto.seatIndex ?? null, dto.userId);
    return { invitationId: invitation.id, expiresAt };
  }

  async respondInvitation(
    actor: RoomActor,
    roomId: string,
    invitationId: string,
    accept: boolean,
  ): Promise<void> {
    await this.assertLiveRoom(roomId);
    const invitation = await this.seats.getInvitation(invitationId);
    if (
      !invitation ||
      invitation.roomId !== roomId ||
      invitation.inviteeUserId !== actor.id ||
      invitation.status !== SeatInvitationStatus.PENDING
    ) {
      throw this.err(
        ERROR_CODES.SEAT_INVITATION_NOT_FOUND,
        'Invitation not found or already resolved.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      await this.seats.resolveInvitation(invitationId, SeatInvitationStatus.EXPIRED, actor.id);
      await this.seats.appendSeatHistory({
        roomId,
        actorId: actor.id,
        action: SeatHistoryAction.INVITE_EXPIRED,
      });
      throw this.err(
        ERROR_CODES.SEAT_INVITATION_EXPIRED,
        'This invitation has expired.',
        HttpStatus.CONFLICT,
      );
    }

    if (!accept) {
      await this.seats.resolveInvitation(invitationId, SeatInvitationStatus.REJECTED, actor.id);
      await this.seats.appendSeatHistory({
        roomId,
        actorId: actor.id,
        action: SeatHistoryAction.INVITE_REJECTED,
      });
      return;
    }

    await this.locks.withLock(roomSeatLockKey(roomId), async () => {
      await this.assertActiveMember(roomId, actor.id);
      if (await this.seats.getSeatByOccupant(roomId, actor.id)) {
        throw this.err(
          ERROR_CODES.ALREADY_ON_SEAT,
          'You are already on a seat.',
          HttpStatus.CONFLICT,
        );
      }
      const seat = await this.findOpenSeatFor(roomId, actor.id, invitation.seatIndex);
      if (!seat) {
        throw this.err(
          ERROR_CODES.SEAT_FULL,
          'No suitable seat is available.',
          HttpStatus.CONFLICT,
        );
      }
      await this.occupy(roomId, seat, actor.id, actor.id);
      await this.seats.resolveInvitation(invitationId, SeatInvitationStatus.ACCEPTED, actor.id);
      await this.seats.appendSeatHistory({
        roomId,
        actorId: actor.id,
        action: SeatHistoryAction.INVITE_ACCEPTED,
        seatIndex: seat.seatIndex,
      });
      await this.bus.publish(
        new SeatJoinedEvent({ roomId, userId: actor.id, seatIndex: seat.seatIndex }),
      );
    });
    await this.rebuildStage(roomId);
  }

  // ======================= Take / leave =======================

  async takeSeat(actor: RoomActor, roomId: string, seatIndex: number): Promise<StageSnapshot> {
    await this.assertLiveRoom(roomId);
    await this.assertActiveMember(roomId, actor.id);
    const settings = await this.requireSettings(roomId);
    const canManage = await this.permissions.hasPermission(
      roomId,
      actor,
      RoomPermission.MANAGE_SEATS,
    );
    if (settings.requireApprovalForSeat && !canManage) {
      throw this.err(
        ERROR_CODES.NOT_ROOM_ADMIN,
        'This room requires approval to take a seat — send a request instead.',
        HttpStatus.FORBIDDEN,
      );
    }

    await this.locks.withLock(roomSeatLockKey(roomId), async () => {
      if (await this.seats.getSeatByOccupant(roomId, actor.id)) {
        throw this.err(
          ERROR_CODES.ALREADY_ON_SEAT,
          'You are already on a seat.',
          HttpStatus.CONFLICT,
        );
      }
      const seat = await this.requireSeat(roomId, seatIndex);
      if (seat.occupantUserId) {
        throw this.err(ERROR_CODES.SEAT_TAKEN, 'That seat is occupied.', HttpStatus.CONFLICT);
      }
      if (seat.isLocked) {
        throw this.err(ERROR_CODES.SEAT_LOCKED, 'That seat is locked.', HttpStatus.CONFLICT);
      }
      await this.assertSeatTypeAllowed(roomId, actor.id, seat);
      await this.occupy(roomId, seat, actor.id, actor.id);
      await this.bus.publish(new SeatJoinedEvent({ roomId, userId: actor.id, seatIndex }));
    });
    return this.rebuildStage(roomId);
  }

  async leaveSeat(actor: RoomActor, roomId: string): Promise<void> {
    await this.assertLiveRoom(roomId);
    await this.locks.withLock(roomSeatLockKey(roomId), async () => {
      const seat = await this.seats.getSeatByOccupant(roomId, actor.id);
      if (!seat) {
        throw this.err(ERROR_CODES.NOT_ON_SEAT, 'You are not on a seat.', HttpStatus.CONFLICT);
      }
      await this.vacate(roomId, seat, actor.id, actor.id, SeatHistoryAction.SEAT_LEFT);
      await this.bus.publish(
        new SeatLeftEvent({ roomId, userId: actor.id, seatIndex: seat.seatIndex }),
      );
      await this.advanceQueue(roomId, seat, actor.id);
    });
    await this.rebuildStage(roomId);
  }

  // ======================= Speaker moderation =======================

  async moveSpeaker(
    actor: RoomActor,
    roomId: string,
    userId: string,
    toSeatIndex: number,
  ): Promise<StageSnapshot> {
    await this.assertLiveRoom(roomId);
    await this.permissions.assertPermission(roomId, actor, RoomPermission.MANAGE_SPEAKERS);
    await this.locks.withLock(roomSeatLockKey(roomId), async () => {
      const from = await this.seats.getSeatByOccupant(roomId, userId);
      if (!from)
        throw this.err(ERROR_CODES.NOT_ON_SEAT, 'That user is not on a seat.', HttpStatus.CONFLICT);
      const to = await this.requireSeat(roomId, toSeatIndex);
      if (to.occupantUserId)
        throw this.err(
          ERROR_CODES.SEAT_TAKEN,
          'Destination seat is occupied.',
          HttpStatus.CONFLICT,
        );
      if (to.isLocked)
        throw this.err(ERROR_CODES.SEAT_LOCKED, 'Destination seat is locked.', HttpStatus.CONFLICT);
      await this.assertSeatTypeAllowed(roomId, userId, to);
      await this.seats.setOccupant(roomId, from.seatIndex, null, actor.id);
      await this.seats.setOccupant(roomId, to.seatIndex, userId, actor.id);
      await this.seats.appendSeatHistory({
        roomId,
        actorId: actor.id,
        subjectUserId: userId,
        action: SeatHistoryAction.SEAT_MOVED,
        seatIndex: to.seatIndex,
        metadata: { fromSeatIndex: from.seatIndex },
      });
    });
    await this.publishUpdate(roomId, actor.id, 'moved', toSeatIndex, userId);
    return this.rebuildStage(roomId);
  }

  async removeSpeaker(actor: RoomActor, roomId: string, userId: string): Promise<void> {
    await this.assertLiveRoom(roomId);
    await this.permissions.assertPermission(roomId, actor, RoomPermission.MANAGE_SPEAKERS);
    await this.locks.withLock(roomSeatLockKey(roomId), async () => {
      const seat = await this.seats.getSeatByOccupant(roomId, userId);
      if (!seat) {
        const member = await this.rooms.getMember(roomId, userId);
        if (member?.tempSpeakAllowed) {
          await this.rooms.setTempSpeakAllowed(roomId, userId, false);
          await this.seats.appendSeatHistory({
            roomId,
            actorId: actor.id,
            subjectUserId: userId,
            action: SeatHistoryAction.SPEAKER_REMOVED,
            metadata: { type: 'REQUEST_TO_SPEAK' },
          });
          await this.publishUpdate(roomId, actor.id, 'temp_speak_revoked', null, userId);
          return;
        }
        throw this.err(ERROR_CODES.NOT_ON_SEAT, 'That user is not on a seat.', HttpStatus.CONFLICT);
      }
      if (seat.seatType === SeatType.OWNER) {
        throw this.err(
          ERROR_CODES.SEAT_TYPE_FORBIDDEN,
          'The room owner cannot be removed from the owner seat.',
          HttpStatus.FORBIDDEN,
        );
      }
      await this.vacate(roomId, seat, actor.id, userId, SeatHistoryAction.SPEAKER_REMOVED);
      await this.bus.publish(new SeatLeftEvent({ roomId, userId, seatIndex: seat.seatIndex }));
      await this.advanceQueue(roomId, seat, actor.id);
    });
    await this.publishUpdate(roomId, actor.id, 'speaker_removed', null, userId);
    await this.rebuildStage(roomId);
  }

  // ======================= Seat lock / mute =======================

  async setSeatLocked(
    actor: RoomActor,
    roomId: string,
    seatIndex: number,
    locked: boolean,
  ): Promise<StageSnapshot> {
    await this.assertLiveRoom(roomId);
    await this.permissions.assertPermission(roomId, actor, RoomPermission.MANAGE_SEATS);
    const seat = await this.requireSeat(roomId, seatIndex);
    if (seat.seatType === SeatType.OWNER) {
      throw this.err(
        ERROR_CODES.SEAT_TYPE_FORBIDDEN,
        'The owner seat cannot be locked.',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.seats.setSeatLocked(roomId, seatIndex, locked, actor.id);
    await this.seats.appendSeatHistory({
      roomId,
      actorId: actor.id,
      action: locked ? SeatHistoryAction.SEAT_LOCKED : SeatHistoryAction.SEAT_UNLOCKED,
      seatIndex,
    });
    await this.bus.publish(
      locked
        ? new SeatLockedEvent({ roomId, actorId: actor.id, seatIndex })
        : new SeatUnlockedEvent({ roomId, actorId: actor.id, seatIndex }),
    );
    return this.rebuildStage(roomId);
  }

  async setSeatMuted(
    actor: RoomActor,
    roomId: string,
    seatIndex: number,
    muted: boolean,
  ): Promise<StageSnapshot> {
    await this.assertLiveRoom(roomId);
    await this.permissions.assertPermission(roomId, actor, RoomPermission.MUTE_USERS);
    const seat = await this.requireSeat(roomId, seatIndex);
    await this.seats.setSeatMuted(roomId, seatIndex, muted, actor.id);
    await this.seats.appendSeatHistory({
      roomId,
      actorId: actor.id,
      subjectUserId: seat.occupantUserId,
      action: muted ? SeatHistoryAction.SEAT_MUTED : SeatHistoryAction.SEAT_UNMUTED,
      seatIndex,
    });
    await this.publishUpdate(
      roomId,
      actor.id,
      muted ? 'muted' : 'unmuted',
      seatIndex,
      seat.occupantUserId,
    );
    return this.rebuildStage(roomId);
  }

  async setRoomMuted(actor: RoomActor, roomId: string, muted: boolean): Promise<StageSnapshot> {
    await this.assertLiveRoom(roomId);
    await this.permissions.assertPermission(roomId, actor, RoomPermission.ROOM_MUTE);
    await this.seats.setRoomMuted(roomId, muted);
    await this.seats.setSpeakerSeatsMuted(roomId, muted, actor.id);
    await this.seats.appendSeatHistory({
      roomId,
      actorId: actor.id,
      action: muted ? SeatHistoryAction.ROOM_MUTED : SeatHistoryAction.ROOM_UNMUTED,
    });
    await this.publishUpdate(roomId, actor.id, muted ? 'room_muted' : 'room_unmuted');
    return this.rebuildStage(roomId);
  }

  // ======================= Role grants =======================

  async grantRole(
    actor: RoomActor,
    roomId: string,
    userId: string,
    role: GrantableRole,
  ): Promise<void> {
    await this.assertLiveRoom(roomId);
    await this.permissions.assertPermission(roomId, actor, RoomPermission.GRANT_ROLES);
    await this.assertActiveMember(roomId, userId);
    const target = role === 'PREMIUM_ADMIN' ? RoomMemberRole.PREMIUM_ADMIN : RoomMemberRole.ADMIN;

    await this.seats.upsertRole(roomId, userId, target, actor.id);
    await this.rooms.setMemberRole(roomId, userId, target, actor.id);
    await this.seats.appendSeatHistory({
      roomId,
      actorId: actor.id,
      subjectUserId: userId,
      action: SeatHistoryAction.ROLE_GRANTED,
      metadata: { role: target },
    });
    if (target === RoomMemberRole.PREMIUM_ADMIN) {
      const seat = await this.seats.getSeatByOccupant(roomId, userId);
      await this.bus.publish(
        new PremiumSeatPurchaseRequestedEvent({
          roomId,
          userId,
          grantedBy: actor.id,
          seatIndex: seat?.seatIndex ?? null,
        }),
      );
    }
    await this.publishUpdate(roomId, actor.id, 'role_granted', null, userId, target);
    await this.rebuildStage(roomId);
  }

  async revokeRole(actor: RoomActor, roomId: string, userId: string): Promise<void> {
    await this.assertLiveRoom(roomId);
    await this.permissions.assertPermission(roomId, actor, RoomPermission.GRANT_ROLES);
    const grant = await this.seats.getRole(roomId, userId);
    if (!grant) {
      throw this.err(
        ERROR_CODES.ROLE_INVALID,
        'That user has no elevated role.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (grant.role === RoomMemberRole.OWNER) {
      throw this.err(
        ERROR_CODES.ROLE_INVALID,
        'The owner role cannot be revoked — transfer ownership instead.',
        HttpStatus.FORBIDDEN,
      );
    }
    await this.locks.withLock(roomSeatLockKey(roomId), async () => {
      await this.seats.deleteRole(roomId, userId);
      await this.rooms.setMemberRole(roomId, userId, RoomMemberRole.LISTENER, actor.id);
      // Losing PREMIUM_ADMIN vacates any premium seat they hold.
      if (grant.role === RoomMemberRole.PREMIUM_ADMIN) {
        const seat = await this.seats.getSeatByOccupant(roomId, userId);
        if (seat && seat.seatType === SeatType.PREMIUM_ADMIN) {
          await this.vacate(roomId, seat, actor.id, userId, SeatHistoryAction.SPEAKER_REMOVED);
          await this.bus.publish(new SeatLeftEvent({ roomId, userId, seatIndex: seat.seatIndex }));
        }
      }
      await this.seats.appendSeatHistory({
        roomId,
        actorId: actor.id,
        subjectUserId: userId,
        action: SeatHistoryAction.ROLE_REVOKED,
      });
    });
    await this.publishUpdate(roomId, actor.id, 'role_revoked', null, userId);
    await this.rebuildStage(roomId);
  }

  // ======================= Room-lifecycle reactions =======================
  // Called by AudioRoomSeatsListener in response to AR-0 room events, so the
  // seat/role state stays consistent without AudioRoomsService depending on it.

  /** A member left the room: vacate their seat, cancel any request, advance queue. */
  async onMemberLeave(roomId: string, userId: string): Promise<void> {
    if (!(await this.rooms.findLiveRoomRow(roomId))) return;
    await this.locks.withLock(roomSeatLockKey(roomId), async () => {
      const pendings = await this.seats.findPendingRequestsByUser(roomId, userId);
      for (const pending of pendings) {
        await this.seats.resolveRequest(pending.id, SeatRequestStatus.CANCELLED, userId);
      }
      if (pendings.length > 0) {
        await this.seats.dequeue(roomId, userId);
      }
      const seat = await this.seats.getSeatByOccupant(roomId, userId);
      if (seat) {
        await this.vacate(roomId, seat, userId, userId, SeatHistoryAction.SEAT_LEFT);
        await this.bus.publish(new SeatLeftEvent({ roomId, userId, seatIndex: seat.seatIndex }));
        await this.advanceQueue(roomId, seat, userId);
      }
    });
    await this.rebuildStage(roomId);
  }

  /** The room went live: occupy Seat 0 automatically for the owner. */
  async onRoomOpened(roomId: string, ownerId: string): Promise<void> {
    await this.locks.withLock(roomSeatLockKey(roomId), async () => {
      // Ensure Seat 0 is occupied by ownerId
      await this.seats.setOccupant(roomId, OWNER_SEAT_INDEX, ownerId, ownerId);
      // Publish SeatJoinedEvent
      await this.bus.publish(
        new SeatJoinedEvent({ roomId, userId: ownerId, seatIndex: OWNER_SEAT_INDEX }),
      );
    });
    await this.rebuildStage(roomId);
  }

  /** The room ended/was deleted: clear all seats + the queue and drop the cache. */
  async onRoomClosed(roomId: string): Promise<void> {
    await this.seats.clearStageTx(roomId);
    await this.seats.invalidateStage(roomId);
  }

  /** Ownership transferred: move the OWNER grant + owner seat to the new owner. */
  async onOwnershipTransfer(
    roomId: string,
    previousOwnerId: string,
    newOwnerId: string,
    actorId: string,
  ): Promise<void> {
    await this.locks.withLock(roomSeatLockKey(roomId), async () => {
      await this.seats.upsertRole(roomId, newOwnerId, RoomMemberRole.OWNER, actorId);
      await this.seats.upsertRole(roomId, previousOwnerId, RoomMemberRole.ADMIN, actorId);
      // Free the new owner's current (non-owner) seat so the owner-seat move
      // does not violate the one-seat-per-user constraint.
      const existing = await this.seats.getSeatByOccupant(roomId, newOwnerId);
      if (existing && existing.seatIndex !== OWNER_SEAT_INDEX) {
        await this.seats.setOccupant(roomId, existing.seatIndex, null, actorId);
      }
      // Move the owner seat (index 0) to the new owner (overwrites the old owner).
      await this.seats.setOccupant(roomId, OWNER_SEAT_INDEX, newOwnerId, actorId);
      await this.seats.appendSeatHistory({
        roomId,
        actorId,
        subjectUserId: newOwnerId,
        action: SeatHistoryAction.SEAT_MOVED,
        seatIndex: OWNER_SEAT_INDEX,
        metadata: { previousOwnerId },
      });
    });
    await this.publishUpdate(
      roomId,
      actorId,
      'role_granted',
      OWNER_SEAT_INDEX,
      newOwnerId,
      RoomMemberRole.OWNER,
    );
    await this.rebuildStage(roomId);
  }

  // ======================= Internal seat mechanics =======================

  /** Occupy a seat + log SEAT_TAKEN (assumes validation already done). */
  private async occupy(
    roomId: string,
    seat: RoomSeat,
    userId: string,
    actorId: string,
  ): Promise<void> {
    await this.seats.setOccupant(roomId, seat.seatIndex, userId, actorId);
    await this.seats.appendSeatHistory({
      roomId,
      actorId,
      subjectUserId: userId,
      action: SeatHistoryAction.SEAT_TAKEN,
      seatIndex: seat.seatIndex,
    });
    await this.seats.resolveAllPendingRequestsForUser(
      roomId,
      userId,
      SeatRequestStatus.ACCEPTED,
      actorId,
    );
  }

  /** Vacate a seat + log the given action. */
  private async vacate(
    roomId: string,
    seat: RoomSeat,
    actorId: string,
    subjectUserId: string,
    action: SeatHistoryAction,
  ): Promise<void> {
    await this.seats.setOccupant(roomId, seat.seatIndex, null, actorId);
    await this.seats.appendSeatHistory({
      roomId,
      actorId,
      subjectUserId,
      action,
      seatIndex: seat.seatIndex,
    });
  }

  /**
   * When a seat frees and the room does not require approval, promote the front
   * of the queue onto that seat (if type-compatible).
   */
  private async advanceQueue(roomId: string, freedSeat: RoomSeat, actorId: string): Promise<void> {
    const settings = await this.requireSettings(roomId);
    if (settings.requireApprovalForSeat) return;
    if (freedSeat.seatType === SeatType.OWNER) return;

    const front = await this.seats.popFront(roomId);
    if (!front) return;
    // Re-read the freed seat (still open) and place the queued user.
    const seat = await this.seats.getSeatByIndex(roomId, freedSeat.seatIndex);
    if (!seat || seat.occupantUserId || seat.isLocked) return;
    const allowed = await this.seatTypeAllowed(roomId, front.userId, seat);
    if (!allowed) return;
    await this.occupy(roomId, seat, front.userId, actorId);
    if (front.requestId) {
      await this.seats.resolveRequest(front.requestId, SeatRequestStatus.ACCEPTED, actorId);
    }
    await this.bus.publish(
      new SeatJoinedEvent({ roomId, userId: front.userId, seatIndex: seat.seatIndex }),
    );
  }

  /** Find an open, unlocked seat the user may occupy (specific index or any). */
  private async findOpenSeatFor(
    roomId: string,
    userId: string,
    seatIndex: number | null,
  ): Promise<RoomSeat | null> {
    if (seatIndex !== null) {
      const seat = await this.seats.getSeatByIndex(roomId, seatIndex);
      if (!seat || seat.occupantUserId || seat.isLocked) return null;
      return (await this.seatTypeAllowed(roomId, userId, seat)) ? seat : null;
    }
    const seats = await this.seats.listSeats(roomId);
    for (const seat of seats) {
      if (seat.seatType === SeatType.OWNER) continue;
      if (seat.occupantUserId || seat.isLocked) continue;
      if (await this.seatTypeAllowed(roomId, userId, seat)) return seat;
    }
    return null;
  }

  /** Whether a user may sit on a seat of the given type. */
  private async seatTypeAllowed(roomId: string, userId: string, seat: RoomSeat): Promise<boolean> {
    if (seat.seatType === SeatType.OWNER) {
      return (await this.rooms.getOwnerId(roomId)) === userId;
    }
    if (seat.seatType === SeatType.PREMIUM_ADMIN) {
      const role = await this.permissions.getEffectiveRole(roomId, userId);
      return role === RoomMemberRole.PREMIUM_ADMIN || role === RoomMemberRole.OWNER;
    }
    return true; // SPEAKER seat — any active member
  }

  private async assertSeatTypeAllowed(
    roomId: string,
    userId: string,
    seat: RoomSeat,
  ): Promise<void> {
    if (!(await this.seatTypeAllowed(roomId, userId, seat))) {
      throw this.err(
        ERROR_CODES.SEAT_TYPE_FORBIDDEN,
        'You are not allowed to occupy this seat type.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  // ======================= Stage snapshot =======================

  private async rebuildStage(roomId: string): Promise<StageSnapshot> {
    const [seats, queue, settings] = await Promise.all([
      this.seats.listSeats(roomId),
      this.seats.listQueue(roomId),
      this.requireSettings(roomId),
    ]);
    const snapshot: StageSnapshot = {
      seats: seats.map((s) => ({
        seatIndex: s.seatIndex,
        seatType: s.seatType,
        occupantUserId: s.occupantUserId,
        isLocked: s.isLocked,
        isMuted: s.isMuted,
      })),
      queue: queue.map((q) => ({ userId: q.userId, position: q.position })),
      settings: {
        speakerSeatCount: settings.speakerSeatCount,
        premiumAdminSeatCount: settings.premiumAdminSeatCount,
        isRoomMuted: settings.isRoomMuted,
        requireApprovalForSeat: settings.requireApprovalForSeat,
        metadata: settings.metadata as Record<string, unknown> | null | undefined,
      },
    };
    await this.seats.setCachedStage(roomId, snapshot, this.stageTtl);
    return snapshot;
  }

  // ======================= Guards / helpers =======================

  private async assertRoomExists(roomId: string): Promise<AudioRoom> {
    const room = await this.rooms.findRoomRow(roomId);
    if (!room) {
      throw this.err(ERROR_CODES.ROOM_NOT_FOUND, 'Room not found.', HttpStatus.NOT_FOUND);
    }
    return room;
  }

  private async assertLiveRoom(roomId: string): Promise<AudioRoom> {
    const room = await this.assertRoomExists(roomId);
    if (room.status !== 'LIVE') {
      throw this.err(ERROR_CODES.ROOM_ENDED, 'This room has ended.', HttpStatus.CONFLICT);
    }
    return room;
  }

  private async assertActiveMember(roomId: string, userId: string): Promise<void> {
    const member = await this.rooms.getMember(roomId, userId);
    if (!member?.isActive) {
      throw this.err(
        ERROR_CODES.NOT_ROOM_MEMBER,
        'You must be in the room to do this.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async requireSeat(roomId: string, seatIndex: number): Promise<RoomSeat> {
    const seat = await this.seats.getSeatByIndex(roomId, seatIndex);
    if (!seat) {
      throw this.err(ERROR_CODES.SEAT_NOT_FOUND, 'Seat not found.', HttpStatus.NOT_FOUND);
    }
    return seat;
  }

  private async requireSettings(roomId: string) {
    const settings = await this.seats.getSettings(roomId);
    if (!settings) {
      throw this.err(ERROR_CODES.ROOM_NOT_FOUND, 'Room settings not found.', HttpStatus.NOT_FOUND);
    }
    return settings;
  }

  private async publishUpdate(
    roomId: string,
    actorId: string,
    reason: SeatUpdateReason,
    seatIndex: number | null = null,
    subjectUserId: string | null = null,
    role: RoomMemberRole | null = null,
  ): Promise<void> {
    await this.bus.publish(
      new SeatUpdatedEvent({ roomId, actorId, reason, seatIndex, subjectUserId, role }),
    );
  }

  private err(
    code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
    message: string,
    status: HttpStatus,
  ) {
    return new BusinessException(code, message, status);
  }
}
