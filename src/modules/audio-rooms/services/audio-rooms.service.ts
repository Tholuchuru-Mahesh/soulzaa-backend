import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  AudioRoom,
  PlatformRole,
  RoomLogAction,
  RoomMemberRole,
  RoomVisibility,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { LockService } from 'src/infra/redis/lock.service';
import { PresenceService } from 'src/infra/redis/presence.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { ROOM_MIN_PARTICIPANTS } from '../constants/audio-room.constants';
import type { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { CreateRoomDto } from '../dto/create-room.dto';

import type { JoinRoomDto } from '../dto/join-room.dto';
import type { ListRoomsDto } from '../dto/list-rooms.dto';
import type { UpdateRoomDto } from '../dto/update-room.dto';
import type { TransferOwnershipDto } from '../dto/transfer-ownership.dto';
import {
  RoomCreatedEvent,
  RoomEndedEvent,
  RoomJoinedEvent,
  RoomLeftEvent,
  RoomLockedEvent,
  RoomOwnershipTransferredEvent,
  RoomProfileUpdatedEvent,
  RoomStartedEvent,
  RoomUpdatedEvent,
} from '../events/audio-room.events';
import type {
  IAudioRoomsService,
  LiveSessionView,
  MicHistoryView,
  RoomHistoryView,
  RoomView,
} from '../interfaces/audio-rooms.service.interface';

import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomsRepository, type UpdateRoomData } from '../repositories/audio-rooms.repository';
import { LiveSessionRepository } from '../repositories/live-session.repository';
import { ModerationRepository } from '../repositories/moderation.repository';
import type { RoomPermission } from '../constants/room-permissions';
import { AudioRoomSeatsService } from './audio-room-seats.service';
import { RoomPasswordService } from './room-password.service';
import { RoomPermissionService } from './room-permission.service';

// Re-exported so existing importers (controller, specs) keep resolving RoomActor
// from this module; the canonical definition lives in interfaces/room-actor.
export type { RoomActor } from '../interfaces/room-actor.interface';

export interface VisibleParticipant {
  userId: string;
  username: string;
  profileImage: string | null;
}

/** A room detail view with its live participant roster. */
export interface RoomDetailView extends RoomView {
  participants: RoomParticipant[];
  visibleParticipants?: VisibleParticipant[];
}

export interface RoomParticipant {
  userId: string;
  username: string | null;
  role: RoomMemberRole;
  joinedAt: Date;
  avatarUrl?: string | null;
  equippedFrameUrl?: string | null;
}

/**
 * Audio Room lifecycle service (PHASE AR-0). Owns room create/edit/delete/end,
 * join/leave, ownership transfer and lock, backed by Postgres (durable record),
 * Redis (authoritative live presence + snapshot cache + trending) and the
 * EVENT_BUS (realtime `room.*` fan-out + downstream analytics/notifications).
 * Concurrency-sensitive paths (per-user create limit, capacity, ownership
 * transfer) run under a distributed lock.
 */
import { ModeratorPerformanceService } from 'src/modules/moderator-performance/services/moderator-performance.service';
import { InvestigationRecordingService } from 'src/modules/investigation-recording/services/investigation-recording.service';
import { PlatformModerationAuditService } from 'src/modules/platform-moderation/services/platform-moderation-audit.service';
import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';

/** Succession order when an owner is removed — highest wins (OWNER never chosen). */
const OWNER_SUCCESSION_PRIORITY: Record<RoomMemberRole, number> = {
  [RoomMemberRole.OWNER]: 6,
  [RoomMemberRole.ADMIN]: 5,
  [RoomMemberRole.PREMIUM_ADMIN]: 4,
  [RoomMemberRole.SPEAKER]: 3,
  [RoomMemberRole.LISTENER]: 2,
  [RoomMemberRole.AUDIENCE]: 1,
};

@Injectable()
export class AudioRoomsService implements IAudioRoomsService {
  private readonly logger = new Logger(AudioRoomsService.name);
  private readonly defaultMax: number;
  private readonly maxCap: number;
  private readonly cacheTtl: number;
  private readonly defaultSpeakerSeats: number;
  private readonly defaultPremiumAdminSeats: number;

  constructor(
    private readonly repo: AudioRoomsRepository,
    private readonly presence: PresenceService,
    private readonly locks: LockService,
    private readonly passwords: RoomPasswordService,
    private readonly config: ConfigService,
    private readonly permissions: RoomPermissionService,
    private readonly seatsService: AudioRoomSeatsService,
    private readonly moderation: ModerationRepository,
    private readonly liveSessions: LiveSessionRepository,
    private readonly media: MediaUrlResolver,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
    @Optional() private readonly performanceStats?: ModeratorPerformanceService,
    @Optional() private readonly investigationRecording?: InvestigationRecordingService,
    @Optional() private readonly platformAudit?: PlatformModerationAuditService,
    @Optional() private readonly platformBans?: PlatformBanService,
  ) {
    // Config namespaces surface raw process.env strings at runtime, so coerce.
    const cfg = this.config.get('audioRoom') as {
      defaultMaxParticipants: number | string;
      maxParticipantsCap: number | string;
      cacheTtlSeconds: number | string;
      defaultSpeakerSeats: number | string;
      defaultPremiumAdminSeats: number | string;
    };
    this.defaultMax = Number(cfg.defaultMaxParticipants);
    this.maxCap = Number(cfg.maxParticipantsCap);
    this.cacheTtl = Number(cfg.cacheTtlSeconds);
    this.defaultSpeakerSeats = Number(cfg.defaultSpeakerSeats);
    this.defaultPremiumAdminSeats = Number(cfg.defaultPremiumAdminSeats);
  }

  // ======================= Commands =======================

  async create(actor: RoomActor, dto: CreateRoomDto): Promise<RoomView> {
    const isModeratorActor = (actor.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );
    if (!isModeratorActor && this.platformBans) {
      await this.platformBans.assertNotGloballyBanned(actor.id);
    }
    return this.locks.withLock(`audio-room:create:{${actor.id}}`, async () => {
      // Rooms are permanent and one-per-owner, so "create" on an owner who
      // already has one means "open a new session on it". Handing the row back
      // untouched used to leave a previously ended room OFFLINE: the owner walked
      // straight into it (owners skip the join gate) while every audience join
      // failed getLiveRoomOrThrow with ROOM_ENDED. Reactivating here makes the
      // room LIVE regardless of which entry path the owner took.
      const existing = await this.repo.findOwnedRoom(actor.id);
      if (existing) {
        // The create form uploads a fresh display picture every time, so handing
        // the existing row back untouched threw that upload away and the owner
        // walked into a room still wearing the old (or no) DP. The image is the
        // one create field that must survive re-opening a permanent room.
        const reopened =
          dto.imageKey !== undefined && dto.imageKey !== existing.imageKey
            ? await this.applyImageKey(actor, existing.id, dto.imageKey)
            : existing;
        return reopened.status === 'LIVE' ? this.toView(reopened) : this.goLive(reopened, actor);
      }

      if (dto.categoryId) await this.assertCategory(dto.categoryId);
      if (dto.language) await this.assertLanguage(dto.language);

      if (dto.isLocked && !dto.password) {
        throw new BusinessException(
          ERROR_CODES.ROOM_PASSWORD_INVALID,
          'A room password is required when locking the room.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const passwordHash = dto.password ? await this.passwords.hash(dto.password) : null;
      const room = await this.repo.createRoomTx({
        ownerId: actor.id,
        name: dto.name,
        description: dto.description ?? null,
        imageKey: dto.imageKey ?? null,
        categoryId: dto.categoryId ?? null,
        language: dto.language ?? null,
        visibility: dto.visibility ?? RoomVisibility.PUBLIC,
        isLocked: dto.isLocked ?? false,
        passwordHash,
        isDiscoverable: dto.isDiscoverable ?? true,
        maxParticipants: this.clampMax(dto.maxParticipants),
        agoraChannel: randomUUID(),
        zegoRoomId: randomUUID(),
        speakerSeatCount: this.defaultSpeakerSeats,
        premiumAdminSeatCount: this.defaultPremiumAdminSeats,
        requireApprovalForSeat: true,
      });

      const view = await this.toView(room);
      await this.repo.setCachedSnapshot(view, this.cacheTtl);
      await this.bus.publish(
        new RoomCreatedEvent({
          roomId: room.id,
          ownerId: room.ownerId,
          name: room.name,
          categoryId: room.categoryId,
          language: room.language,
          visibility: room.visibility,
        }),
      );
      return view;
    });
  }

  async update(actor: RoomActor, roomId: string, dto: UpdateRoomDto): Promise<RoomView> {
    const room = await this.getManageableRoom(roomId, actor);

    if (dto.categoryId) await this.assertCategory(dto.categoryId);
    if (dto.language) await this.assertLanguage(dto.language);

    // Validate password requirement
    const willBeLocked = dto.isLocked !== undefined ? dto.isLocked : room.isLocked;
    const hasPassword =
      dto.password !== undefined ? dto.password !== null : room.passwordHash !== null;
    if (willBeLocked && !hasPassword) {
      throw new BusinessException(
        ERROR_CODES.ROOM_PASSWORD_INVALID,
        'A room password is required when locking the room.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const data: UpdateRoomData = {};
    const changed: string[] = [];
    const assign = <K extends keyof UpdateRoomData>(key: K, value: UpdateRoomData[K]): void => {
      data[key] = value;
      changed.push(key);
    };

    if (dto.name !== undefined) assign('name', dto.name);
    if (dto.description !== undefined) assign('description', dto.description);
    if (dto.imageKey !== undefined) assign('imageKey', dto.imageKey);
    if (dto.categoryId !== undefined) assign('categoryId', dto.categoryId);
    if (dto.language !== undefined) assign('language', dto.language);
    if (dto.visibility !== undefined) assign('visibility', dto.visibility);
    if (dto.isDiscoverable !== undefined) assign('isDiscoverable', dto.isDiscoverable);
    if (dto.maxParticipants !== undefined)
      assign('maxParticipants', this.clampMax(dto.maxParticipants));

    if (dto.isLocked !== undefined) {
      assign('isLocked', dto.isLocked);
      if (!dto.isLocked) {
        assign('passwordHash', null);
      }
    }

    if (dto.password !== undefined) {
      assign('passwordHash', dto.password ? await this.passwords.hash(dto.password) : null);
      if (changed.length > 0) {
        changed[changed.length - 1] = 'password';
      } else {
        changed.push('password');
      }
    }

    const updated = await this.repo.updateRoom(roomId, data, actor.id);

    if (dto.imageKey !== undefined) {
      await this.repo.appendLog(roomId, actor.id, RoomLogAction.IMAGE_UPDATED);
    }
    if (dto.isLocked !== undefined) {
      await this.repo.appendLog(
        roomId,
        actor.id,
        dto.isLocked ? RoomLogAction.LOCKED : RoomLogAction.UNLOCKED,
      );
      await this.bus.publish(
        new RoomLockedEvent({ roomId, actorId: actor.id, isLocked: dto.isLocked }),
      );
    }
    await this.repo.appendLog(roomId, actor.id, RoomLogAction.UPDATED, { changed });

    const view = await this.refreshCache(updated);
    await this.bus.publish(new RoomUpdatedEvent({ roomId, actorId: actor.id, changed }));
    if (dto.imageKey !== undefined) {
      await this.publishProfileUpdated(roomId, actor.id, view);
    }
    return view;
  }

  /**
   * Writes a new display picture onto an existing room and announces it. The
   * narrow counterpart to [update] for the create path, where the caller is
   * re-opening a room they already own and only the image may carry over.
   */
  private async applyImageKey(
    actor: RoomActor,
    roomId: string,
    imageKey: string | null,
  ): Promise<AudioRoom> {
    const updated = await this.repo.updateRoom(roomId, { imageKey }, actor.id);
    await this.repo.appendLog(roomId, actor.id, RoomLogAction.IMAGE_UPDATED);
    const view = await this.refreshCache(updated);
    await this.publishProfileUpdated(roomId, actor.id, view);
    return updated;
  }

  /**
   * Announces a display-picture change on its own event, carrying the resolved
   * URL. `room.updated` names the changed fields but not their values, so every
   * client had to re-fetch the whole room to redraw one avatar — and discovery
   * screens, which subscribe to no room channel, never heard about it at all.
   * This payload is self-sufficient and fans out namespace-wide for that reason.
   */
  private async publishProfileUpdated(
    roomId: string,
    actorId: string,
    view: RoomView,
  ): Promise<void> {
    await this.bus.publish(
      new RoomProfileUpdatedEvent({
        roomId,
        actorId,
        imageKey: view.imageKey,
        imageUrl: view.imageUrl,
      }),
    );
  }

  async setLock(actor: RoomActor, roomId: string, isLocked: boolean): Promise<RoomView> {
    return this.update(actor, roomId, { isLocked });
  }

  async remove(_actor: RoomActor, _roomId: string): Promise<void> {
    throw new BusinessException(
      ERROR_CODES.FORBIDDEN,
      'Permanent rooms cannot be deleted.',
      HttpStatus.FORBIDDEN,
    );
  }

  async end(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.repo.findRoomRow(roomId);
    if (!room) throw this.roomNotFound();
    if (room.ownerId !== actor.id && !this.isPlatformAdmin(actor.roles)) {
      throw new BusinessException(
        ERROR_CODES.NOT_ROOM_OWNER,
        'Only the room owner or a platform admin can end this room.',
        HttpStatus.FORBIDDEN,
      );
    }
    await this.endRoomInternal(room, actor.id);
  }

  /**
   * Closes a live broadcast session: updates DB status to OFFLINE, finalises statistics,
   * closes live session window, clears Redis runtime state, and broadcasts RoomEndedEvent.
   */
  async endRoomInternal(room: AudioRoom, actorId: string): Promise<void> {
    const roomId = room.id;
    const durationSeconds = (Date.now() - room.createdAt.getTime()) / 1000;
    await this.repo.endRoom(roomId, actorId, durationSeconds);
    await this.repo.appendLog(roomId, actorId, RoomLogAction.ENDED, {
      durationSeconds: Math.floor(durationSeconds),
    });
    // Creator Center — Live History: close this broadcast's own session window
    // (distinct from `durationSeconds` above, which is measured since the
    // permanent room row was first created, not since this particular go-live).
    const openSession = await this.liveSessions.getOpenSession(roomId);
    if (openSession) {
      const sessionDurationSeconds = Math.floor(
        (Date.now() - openSession.startedAt.getTime()) / 1000,
      );
      await this.liveSessions.closeSession(openSession.id, new Date(), sessionDurationSeconds);
    }
    await this.clearRoomRuntime(roomId);
    await this.bus.publish(
      new RoomEndedEvent({
        roomId,
        actorId,
        ownerId: room.ownerId,
        durationSeconds: Math.floor(durationSeconds),
      }),
    );
  }

  /**
   * Sweeps all currently LIVE rooms and auto-ends any room where participant count is 0
   * after a startup grace period.
   */
  async autoEndEmptyRooms(): Promise<void> {
    const liveRooms = await this.repo.findLiveRooms();
    for (const room of liveRooms) {
      try {
        const count = await this.presence.roomMemberCount(room.id);
        const ageMs = Date.now() - (room.updatedAt?.getTime() ?? room.createdAt.getTime());
        // Grace period of 20 seconds so freshly started rooms have time for host to join presence
        if (count <= 0 && ageMs > 20000) {
          this.logger.log(`Auto-ending empty live audio room ${room.id}`);
          await this.endRoomInternal(room, room.ownerId);
        }
      } catch (err) {
        this.logger.warn(`Failed to auto-end empty room ${room.id}: ${(err as Error).message}`);
      }
    }
  }

  async start(actor: RoomActor, roomId: string): Promise<RoomView> {
    const isModeratorActor = (actor.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );
    if (!isModeratorActor && this.platformBans) {
      await this.platformBans.assertNotGloballyBanned(actor.id);
    }
    const room = await this.getManageableRoom(roomId, actor);
    return this.goLive(room, actor);
  }

  /**
   * Opens a new LIVE session on an existing (permanent) room. Rooms are one per
   * owner and are never deleted, so "start another live" reactivates this row —
   * but it must be a genuinely fresh session, never a resumption of the ended
   * one: any presence/trending/snapshot state the previous session left behind is
   * discarded first.
   *
   * Idempotent. Calling it on a room that is already LIVE is a no-op restart: the
   * runtime reset is skipped so a redundant `POST /:id/start` (the client calls
   * start-then-join on every owner entry) can never evict the live audience.
   */
  private async goLive(room: AudioRoom, actor: RoomActor): Promise<RoomView> {
    const roomId = room.id;
    const restarted = room.status !== 'LIVE';

    if (restarted) {
      await this.clearRoomRuntime(roomId);
    }

    const updated = restarted
      ? await this.repo.updateRoom(roomId, { status: 'LIVE', endedAt: null }, actor.id)
      : room;
    await this.seatsService.onRoomOpened(roomId, updated.ownerId, restarted);

    if (restarted) {
      // Creator Center — Live History: a genuine OFFLINE→LIVE transition opens
      // a new broadcast session; a redundant restart-while-LIVE does not.
      await this.liveSessions.openSession(roomId, updated.ownerId);
    }

    const view = await this.toView(updated);
    await this.repo.setCachedSnapshot(view, this.cacheTtl);
    await this.repo.trendingBump(roomId, 0);

    if (restarted) {
      await this.repo.appendLog(roomId, actor.id, RoomLogAction.UPDATED, { changed: ['status'] });
    }

    await this.bus.publish(
      new RoomStartedEvent({
        roomId,
        ownerId: updated.ownerId,
        actorId: actor.id,
        name: updated.name,
        imageKey: updated.imageKey,
        imageUrl: view.imageUrl,
        categoryId: updated.categoryId,
        language: updated.language,
        visibility: updated.visibility,
        isDiscoverable: updated.isDiscoverable,
        isLocked: updated.isLocked,
        isPasswordProtected: updated.passwordHash !== null,
        maxParticipants: updated.maxParticipants,
        participantCount: view.participantCount,
        status: view.status,
        restarted,
      }),
    );
    // Kept for clients already inside the room, which reconcile on `room.updated`.
    await this.bus.publish(
      new RoomUpdatedEvent({
        roomId,
        actorId: actor.id,
        changed: ['status'],
      }),
    );
    return view;
  }

  async join(actor: RoomActor, roomId: string, dto: JoinRoomDto): Promise<RoomDetailView> {
    const room = await this.getLiveRoomOrThrow(roomId);

    const isModeratorActor = (actor.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );
    if (!isModeratorActor && this.platformBans) {
      await this.platformBans.assertNotGloballyBanned(actor.id);
    }

    // Re-entry restrictions: a user on the kick list or with an active ban cannot
    // rejoin until a moderator restores/unbans them (AR-3).
    await this.assertNotKicked(roomId, actor.id);
    await this.assertNotBanned(roomId, actor.id);

    // Incognito moderators bypass the password too, not just ADMIN/SUPER_ADMIN —
    // a locked room shouldn't block the investigative access this feature exists for.
    const isOwnerOrPlatformAdmin =
      room.ownerId === actor.id || this.isPlatformAdmin(actor.roles) || isModeratorActor;
    const existingMember = await this.repo.getMember(roomId, actor.id);
    const isAlreadyInRoom = existingMember?.isActive === true;

    if (room.isLocked && room.passwordHash && !isAlreadyInRoom && !isOwnerOrPlatformAdmin) {
      const ok = dto.password
        ? await this.passwords.verify(dto.password, room.passwordHash)
        : false;
      if (!ok) {
        throw new BusinessException(
          ERROR_CODES.ROOM_PASSWORD_INVALID,
          'Incorrect room password.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const isModerator = isModeratorActor;

    if (isModerator) {
      if (isAlreadyInRoom) {
        // A user promoted to MODERATOR mid-session (or otherwise already a
        // visible participant) rejoining must become retroactively invisible
        // — drop the stale public RoomMember row and public presence entry
        // before adding them to the moderator-only set below. Without this,
        // a promoted user's earlier visible join keeps counting/listing them
        // even while "incognito".
        await this.repo.deactivateMember(roomId, actor.id, actor.id);
        await this.presence.leaveRoom(roomId, actor.id);
      }
      await this.presence.joinRoom(roomId, actor.id, true);
      if (this.performanceStats) {
        void this.performanceStats.recordAction(actor.id, 'ROOM_VISITED');
      }
      if (this.investigationRecording) {
        void this.moderation.listPendingReports(roomId).then((reports) =>
          Promise.all(
            reports.map((report) =>
              this.investigationRecording!.beginOrReuseRecording({
                moderatorId: actor.id,
                targetUserId: report.targetUserId,
                roomId,
                evidencePayload: { roomId, reportId: report.id, trigger: 'room_join' },
              }),
            ),
          ),
        );
      }
      if (this.platformAudit) {
        void this.platformAudit.record({
          moderatorId: actor.id,
          action: 'INCOGNITO_JOIN',
          roomType: 'AUDIO_ROOM',
          roomId,
        });
      }
      return this.getRoomDetail(roomId);
    }

    await this.locks.withLock(`audio-room:join:{${roomId}}`, async () => {
      const alreadyIn = await this.presence.isInRoom(roomId, actor.id);
      if (!alreadyIn) {
        const count = await this.presence.roomMemberCount(roomId);
        if (count >= room.maxParticipants) {
          throw new BusinessException(
            ERROR_CODES.ROOM_FULL,
            'This room is full.',
            HttpStatus.CONFLICT,
          );
        }
      }
      await this.presence.joinRoom(roomId, actor.id);
      const role = room.ownerId === actor.id ? RoomMemberRole.OWNER : RoomMemberRole.LISTENER;
      await this.repo.upsertActiveMember(roomId, actor.id, role, actor.id);
      await this.repo.upsertPresence(roomId, actor.id);

      if (room.ownerId === actor.id) {
        try {
          await this.seatsService.takeSeat(actor, roomId, 0);
        } catch (e) {
          // Ignore if they are already seated or if the seat is occupied/locked
          this.logger.warn(
            `Could not auto-seat owner ${actor.id} on join: ${(e as Error).message}`,
          );
        }
      }
    });

    const count = await this.presence.roomMemberCount(roomId);
    await this.repo.bumpStatsOnJoin(roomId, count);
    await this.repo.trendingBump(roomId);
    await this.repo.appendLog(roomId, actor.id, RoomLogAction.JOINED);
    await this.bus.publish(
      new RoomJoinedEvent({ roomId, userId: actor.id, participantCount: count }),
    );

    return this.getRoomDetail(roomId);
  }

  async leave(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.repo.findRoomRow(roomId);
    if (!room) throw this.roomNotFound();

    const isModerator = (actor.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );

    if (isModerator) {
      await this.presence.leaveRoom(roomId, actor.id, true);
      if (this.platformAudit) {
        void this.platformAudit.record({
          moderatorId: actor.id,
          action: 'INCOGNITO_LEAVE',
          roomType: 'AUDIO_ROOM',
          roomId,
        });
      }
      return;
    }

    await this.presence.leaveRoom(roomId, actor.id);
    await this.repo.deactivateMember(roomId, actor.id, actor.id);
    await this.repo.removePresence(roomId, actor.id);

    const count = await this.presence.roomMemberCount(roomId);
    await this.repo.bumpStatsOnLeave(roomId, count);
    await this.repo.appendLog(roomId, actor.id, RoomLogAction.LEFT);
    await this.bus.publish(
      new RoomLeftEvent({ roomId, userId: actor.id, participantCount: count }),
    );

    // Auto-end the live audio room if no one is left in the room
    if (room.status === 'LIVE' && count <= 0) {
      await this.endRoomInternal(room, actor.id);
    }
  }

  async transferOwnership(
    actor: RoomActor,
    roomId: string,
    dto: TransferOwnershipDto,
  ): Promise<RoomView> {
    const room = await this.getManageableRoom(roomId, actor);
    if (dto.newOwnerId === room.ownerId) {
      throw new BusinessException(
        ERROR_CODES.CONFLICT,
        'User is already the room owner.',
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.locks.withLock(`audio-room:transfer:{${roomId}}`, async () => {
      const newOwnerMember = await this.repo.getMember(roomId, dto.newOwnerId);
      if (!newOwnerMember || !newOwnerMember.isActive) {
        throw new BusinessException(
          ERROR_CODES.NOT_ROOM_MEMBER,
          'The new owner must be an active member of the room.',
          HttpStatus.BAD_REQUEST,
        );
      }
      // Demote the previous owner to ADMIN, promote the new owner.
      await this.repo.setMemberRole(roomId, room.ownerId, RoomMemberRole.ADMIN, actor.id);
      await this.repo.setMemberRole(roomId, dto.newOwnerId, RoomMemberRole.OWNER, actor.id);
      return this.repo.setOwner(roomId, dto.newOwnerId, actor.id);
    });

    await this.repo.appendLog(roomId, actor.id, RoomLogAction.OWNERSHIP_TRANSFERRED, {
      previousOwnerId: room.ownerId,
      newOwnerId: dto.newOwnerId,
    });
    const view = await this.refreshCache(updated);
    await this.bus.publish(
      new RoomOwnershipTransferredEvent({
        roomId,
        previousOwnerId: room.ownerId,
        newOwnerId: dto.newOwnerId,
        actorId: actor.id,
      }),
    );
    return view;
  }

  /**
   * Admin "remove owner": strip ownership from the current owner and promote the
   * highest-ranking remaining active member to OWNER (demoting the old owner to
   * LISTENER). If the room has no other active member, the room is closed. The
   * acting admin never becomes the owner.
   */
  async removeOwner(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.getManageableRoom(roomId, actor);

    const members = await this.repo.listActiveMembers(roomId);
    const successor = members
      .filter((m) => m.userId !== room.ownerId)
      .sort(
        (a, b) =>
          OWNER_SUCCESSION_PRIORITY[b.role] - OWNER_SUCCESSION_PRIORITY[a.role] ||
          a.joinedAt.getTime() - b.joinedAt.getTime(),
      )[0];

    // No one to hand the room to — closing it is the only sane outcome.
    if (!successor) {
      await this.end(actor, roomId);
      return;
    }

    await this.locks.withLock(`audio-room:transfer:{${roomId}}`, async () => {
      await this.repo.setMemberRole(roomId, room.ownerId, RoomMemberRole.LISTENER, actor.id);
      await this.repo.setMemberRole(roomId, successor.userId, RoomMemberRole.OWNER, actor.id);
      await this.repo.setOwner(roomId, successor.userId, actor.id);
    });

    await this.repo.appendLog(roomId, actor.id, RoomLogAction.OWNERSHIP_TRANSFERRED, {
      previousOwnerId: room.ownerId,
      newOwnerId: successor.userId,
      removedByAdmin: true,
    });

    const updated = await this.repo.findRoomRow(roomId);
    if (updated) {
      await this.refreshCache(updated);
    }

    await this.bus.publish(
      new RoomOwnershipTransferredEvent({
        roomId,
        previousOwnerId: room.ownerId,
        newOwnerId: successor.userId,
        actorId: actor.id,
      }),
    );
  }

  // ======================= Queries =======================

  async getRoomDetail(roomId: string): Promise<RoomDetailView> {
    const room = await this.repo.findRoomRow(roomId);
    if (!room) throw this.roomNotFound();
    const view = await this.toView(room);
    const allMembers = await this.repo.listActiveMembers(roomId);
    const ids = allMembers.map((m) => m.userId);
    const identities = await this.profiles.resolvePublicIdentities(ids);
    // resolvePublicIdentities drops hidden staff accounts (e.g. anonymous
    // Moderators) from the map entirely — filter their roster rows out here
    // too, rather than returning a row with every field blanked. Anonymity
    // means the row is absent, not present-but-empty.
    const members = allMembers.filter((m) => identities.has(m.userId));

    const participants = members.map((m) => {
      const identity = identities.get(m.userId);
      return {
        userId: m.userId,
        username: identity?.username ?? null,
        role: m.role,
        joinedAt: m.joinedAt,
        avatarUrl: identity?.avatarUrl ?? null,
        equippedFrameUrl: identity?.equippedFrameUrl ?? null,
      };
    });

    // Get visible participants (first 3 active members sorted by joinedAt)
    const first3Members = members.slice(0, 3);
    const visibleParticipants = first3Members.map((m) => {
      const identity = identities.get(m.userId);
      return {
        userId: m.userId,
        username: identity?.displayName ?? '',
        profileImage: identity?.avatarUrl ?? null,
        equippedFrameUrl: identity?.equippedFrameUrl ?? null,
      };
    });

    return { ...view, participants, visibleParticipants };
  }

  /** The caller's active owned room, or null when they own none. */
  async getMyRoom(actor: RoomActor): Promise<RoomView | null> {
    const room = await this.repo.findOwnedRoom(actor.id);
    return room ? this.toView(room) : null;
  }

  /** The caller's room participation history (joined & hosted rooms). */
  async listRoomHistory(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<RoomHistoryView>> {
    const { rows, total } = await this.repo.listUserRoomHistory(userId, query.skip, query.limit);

    const items = await Promise.all(
      rows.map(async (m) => {
        const room = await this.repo.findRoomRow(m.roomId);
        const owner = room ? await this.users.findById(room.ownerId).catch(() => null) : null;
        const durationSeconds = m.leftAt
          ? Math.max(0, Math.floor((m.leftAt.getTime() - m.joinedAt.getTime()) / 1000))
          : Math.max(0, Math.floor((Date.now() - m.joinedAt.getTime()) / 1000));
        return {
          id: m.id,
          roomId: m.roomId,
          roomName: room?.name ?? 'Audio Room',
          roomImageKey: room?.imageKey ?? null,
          roomImageUrl: room?.imageKey ? await this.media.resolve(room.imageKey) : null,
          ownerId: room?.ownerId ?? '',
          ownerName: owner?.username ?? 'Host',
          role: m.role,
          joinedAt: m.joinedAt,
          leftAt: m.leftAt,
          durationSeconds,
          status: room?.status ?? 'ENDED',
          participantCount: room ? await this.presence.roomMemberCount(room.id) : 0,
        };
      }),
    );

    return buildPaginated(items, total, query.page, query.limit);
  }

  // ======================= Favorites =======================

  async addFavorite(userId: string, roomId: string): Promise<{ favorited: true }> {
    const room = await this.repo.findRoomRow(roomId);
    if (!room) throw this.roomNotFound();
    await this.repo.addFavorite(userId, roomId);
    return { favorited: true };
  }

  async removeFavorite(userId: string, roomId: string): Promise<{ favorited: false }> {
    await this.repo.removeFavorite(userId, roomId);
    return { favorited: false };
  }

  async isFavorite(userId: string, roomId: string): Promise<{ isFavorite: boolean }> {
    const isFav = await this.repo.isFavorite(userId, roomId);
    return { isFavorite: isFav };
  }

  async listFavorites(userId: string, query: PaginationQueryDto): Promise<Paginated<RoomView>> {
    const { rows, total } = await this.repo.listUserFavorites(userId, query.skip, query.limit);

    const roomViews = await Promise.all(
      rows.map(async (fav) => {
        const room = await this.repo.findRoomRow(fav.roomId);
        return room ? this.toView(room) : null;
      }),
    );

    const validViews = roomViews.filter((v): v is RoomView => v !== null);
    return buildPaginated(validViews, total, query.page, query.limit);
  }

  // ======================= Mic Sessions =======================

  /** The caller's mic seat session history. */
  async listMicHistory(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<MicHistoryView>> {
    const { rows, total } = await this.repo.listUserMicHistory(userId, query.skip, query.limit);

    const items = await Promise.all(
      rows.map(async (m) => {
        const room = await this.repo.findRoomRow(m.roomId);
        const owner = room ? await this.users.findById(room.ownerId).catch(() => null) : null;
        const durationSeconds =
          m.durationSeconds ??
          (m.endedAt
            ? Math.max(0, Math.floor((m.endedAt.getTime() - m.startedAt.getTime()) / 1000))
            : Math.max(0, Math.floor((Date.now() - m.startedAt.getTime()) / 1000)));
        return {
          id: m.id,
          roomId: m.roomId,
          roomName: room?.name ?? 'Audio Room',
          roomImageKey: room?.imageKey ?? null,
          roomImageUrl: room?.imageKey ? await this.media.resolve(room.imageKey) : null,
          ownerId: room?.ownerId ?? '',
          ownerName: owner?.username ?? 'Host',
          seatIndex: m.seatIndex,
          startedAt: m.startedAt,
          endedAt: m.endedAt,
          durationSeconds,
          status: room?.status ?? 'ENDED',
        };
      }),
    );

    return buildPaginated(items, total, query.page, query.limit);
  }

  /** Creator Center — Live History: the caller's own past broadcast sessions. */
  async listMyLiveSessions(
    ownerId: string,
    skip: number,
    take: number,
  ): Promise<{ rows: LiveSessionView[]; total: number }> {
    const [rows, total] = await this.liveSessions.listByOwner(ownerId, skip, take);
    return { rows: rows.map((s) => this.toLiveSessionView(s)), total };
  }

  /** Creator Center — Live History detail; null if missing or not the caller's own. */
  async getMyLiveSession(ownerId: string, sessionId: string): Promise<LiveSessionView | null> {
    const session = await this.liveSessions.findByIdForOwner(ownerId, sessionId);
    return session ? this.toLiveSessionView(session) : null;
  }

  private toLiveSessionView(s: {
    id: string;
    roomId: string;
    startedAt: Date;
    endedAt: Date | null;
    durationSeconds: number | null;
    status: string;
  }): LiveSessionView {
    return {
      id: s.id,
      roomId: s.roomId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationSeconds: s.durationSeconds,
      status: s.status as LiveSessionView['status'],
    };
  }

  async list(query: ListRoomsDto, actor: RoomActor): Promise<Paginated<RoomView>> {
    const privileged = this.isPlatformAdmin(actor.roles);
    const { rows, total } = await this.repo.listRooms({
      skip: query.skip,
      take: query.limit,
      categoryId: query.categoryId,
      language: query.language,
      search: query.search,
      visibility: privileged ? query.visibility : undefined,
      discoverableOnly: !privileged,
    });
    const views = await Promise.all(rows.map((r) => this.toView(r)));
    return buildPaginated(views, total, query.page, query.limit);
  }

  async trending(limit: number): Promise<RoomView[]> {
    const ids = await this.repo.trendingTopIds(limit);
    let rows = await this.repo.findLiveRoomsByIds(ids);
    rows = rows.filter((r) => r.isDiscoverable && r.visibility === RoomVisibility.PUBLIC);
    if (rows.length < limit) {
      const fallback = await this.repo.listTopRoomsByStatistics(limit);
      const seen = new Set(rows.map((r) => r.id));
      for (const r of fallback) {
        if (rows.length >= limit) break;
        if (!seen.has(r.id)) rows.push(r);
      }
    }
    return Promise.all(rows.slice(0, limit).map((r) => this.toView(r)));
  }

  listCategories() {
    return this.repo.listActiveCategories();
  }

  listLanguages() {
    return this.repo.listActiveLanguages();
  }

  // ======================= Public contract (IAudioRoomsService) =======================

  async getRoom(roomId: string): Promise<RoomView | null> {
    const cached = await this.repo.getCachedSnapshot(roomId);
    if (cached) {
      return {
        ...cached,
        // `imageUrl` is derived and may be a short-lived presigned GET, so it can
        // outlive its signature inside a longer-lived snapshot. `imageKey` is the
        // durable fact — re-resolve from it rather than serve an expired URL.
        imageUrl: await this.media.resolve(cached.imageKey),
        participantCount: await this.participantCount(roomId),
      };
    }
    const room = await this.repo.findRoomRow(roomId);
    if (!room) return null;
    const view = await this.toView(room);
    await this.repo.setCachedSnapshot(view, this.cacheTtl);
    return view;
  }

  async isRoomLive(roomId: string): Promise<boolean> {
    const room = await this.repo.findLiveRoomRow(roomId);
    return room !== null;
  }

  async getOwnerId(roomId: string): Promise<string | null> {
    const room = await this.repo.findRoomRow(roomId);
    return room?.ownerId ?? null;
  }

  async isMember(roomId: string, userId: string): Promise<boolean> {
    const member = await this.repo.getMember(roomId, userId);
    return member?.isActive === true;
  }

  /**
   * True when the user has a room_member row for this room, regardless of
   * whether they are currently active. Used for gift-receiver validation:
   * a member who stepped out is still a legitimate recipient while the room
   * is LIVE (e.g. the owner who left but did not end the room).
   */
  async hasEverBeenMember(roomId: string, userId: string): Promise<boolean> {
    const member = await this.repo.getMember(roomId, userId);
    return member !== null && member !== undefined;
  }

  async getMemberRole(roomId: string, userId: string): Promise<RoomMemberRole | null> {
    // Effective role: room_roles grant → speaker seat → listener (AR-1).
    return this.permissions.getEffectiveRole(roomId, userId);
  }

  async assertMember(roomId: string, userId: string): Promise<void> {
    if (!(await this.isMember(roomId, userId))) {
      throw new BusinessException(
        ERROR_CODES.NOT_ROOM_MEMBER,
        'You are not a member of this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  participantCount(roomId: string): Promise<number> {
    return this.presence.roomMemberCount(roomId);
  }

  getEffectiveRole(roomId: string, userId: string): Promise<RoomMemberRole | null> {
    return this.permissions.getEffectiveRole(roomId, userId);
  }

  hasRoomPermission(roomId: string, userId: string, permission: RoomPermission): Promise<boolean> {
    return this.permissions.userHasPermission(roomId, userId, permission);
  }

  isSpeaker(roomId: string, userId: string): Promise<boolean> {
    return this.permissions.isSpeaker(roomId, userId);
  }

  isRoomMuted(roomId: string): Promise<boolean> {
    return this.seatsService.isRoomMuted(roomId);
  }

  isSeatMuted(roomId: string, userId: string): Promise<boolean> {
    return this.seatsService.isSeatMuted(roomId, userId);
  }

  getStage(roomId: string) {
    return this.seatsService.getStage(roomId);
  }

  // ======================= Internals =======================

  private clampMax(requested?: number): number {
    const value = requested ?? this.defaultMax;
    return Math.min(this.maxCap, Math.max(ROOM_MIN_PARTICIPANTS, value));
  }

  private isPlatformAdmin(roles: PlatformRole[]): boolean {
    return roles.includes(PlatformRole.ADMIN) || roles.includes(PlatformRole.SUPER_ADMIN);
  }

  private async getManageableRoom(roomId: string, actor: RoomActor): Promise<AudioRoom> {
    const room = await this.repo.findRoomRow(roomId);
    if (!room) throw this.roomNotFound();
    if (room.ownerId !== actor.id && !this.isPlatformAdmin(actor.roles)) {
      const role = await this.permissions.getEffectiveRole(roomId, actor.id);
      if (role !== RoomMemberRole.ADMIN && role !== RoomMemberRole.PREMIUM_ADMIN) {
        throw new BusinessException(
          ERROR_CODES.NOT_ROOM_OWNER,
          'Only the room owner, admin, or a platform admin can manage this room.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
    return room;
  }

  private async assertNotKicked(_roomId: string, _userId: string): Promise<void> {
    // Kick functionality removed — no-op.
    return;
  }

  /**
   * Throws ROOM_BANNED when the user has an active ban. Redis is the fast path;
   * the DB is consulted only on a cache miss (and warms the cache), so a ban
   * survives a Redis flush.
   */
  private async assertNotBanned(roomId: string, userId: string): Promise<void> {
    if (await this.moderation.isBannedCached(roomId, userId)) {
      throw new BusinessException(
        ERROR_CODES.ROOM_BANNED,
        'You are banned from this room.',
        HttpStatus.FORBIDDEN,
      );
    }
    const ban = await this.moderation.findActiveBan(roomId, userId);
    if (ban) {
      // Warm the cache (respecting a temporary ban's remaining TTL).
      const ttlMs = ban.expiresAt ? ban.expiresAt.getTime() - Date.now() : null;
      if (ttlMs === null || ttlMs > 0) {
        await this.moderation.addBanCache(roomId, userId, ttlMs);
        const reasonText = ban.reason ? ` Reason: ${ban.reason}` : '';
        throw new BusinessException(
          ERROR_CODES.ROOM_BANNED,
          `You are banned from joining rooms.${reasonText}`,
          HttpStatus.FORBIDDEN,
        );
      }
    }
  }

  private async getLiveRoomOrThrow(roomId: string): Promise<AudioRoom> {
    const room = await this.repo.findRoomRow(roomId);
    if (!room) throw this.roomNotFound();
    if (room.status !== 'LIVE') {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'This room has ended.',
        HttpStatus.CONFLICT,
      );
    }
    return room;
  }

  private async assertCategory(categoryId: string): Promise<void> {
    if (!(await this.repo.categoryExists(categoryId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_CATEGORY_INVALID,
        'Unknown room category.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertLanguage(code: string): Promise<void> {
    if (!(await this.repo.languageExists(code))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_LANGUAGE_INVALID,
        'Unsupported room language.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async toView(room: AudioRoom): Promise<RoomView> {
    const prisma = (this.repo as any).prisma;
    const totalGifts = prisma
      ? await prisma.giftTransaction.aggregate({
          _sum: { totalCoinValue: true },
          where: { contextId: room.id },
        })
      : null;
    const giftCoins = totalGifts ? Number(totalGifts._sum.totalCoinValue || 0) : 0;

    let ownerName: string | undefined;
    if (prisma) {
      const ownerUser = await prisma.user.findUnique({
        where: { id: room.ownerId },
        select: { username: true, fullName: true },
      });
      if (ownerUser) {
        ownerName = ownerUser.fullName || ownerUser.username;
      }
    }

    return {
      id: room.id,
      ownerId: room.ownerId,
      ownerName: ownerName,
      name: room.name,
      description: room.description,
      imageKey: room.imageKey,
      imageUrl: await this.media.resolve(room.imageKey),
      categoryId: room.categoryId,
      language: room.language,
      visibility: room.visibility,
      isLocked: room.isLocked,
      isPasswordProtected: room.passwordHash !== null,
      isDiscoverable: room.isDiscoverable,
      maxParticipants: room.maxParticipants,
      status: room.status,
      participantCount: await this.presence.roomMemberCount(room.id),
      agoraChannel: room.agoraChannel,
      zegoRoomId: room.zegoRoomId,
      createdAt: room.createdAt,
      endedAt: room.endedAt,
      giftCoins: giftCoins,
    };
  }

  private async refreshCache(room: AudioRoom): Promise<RoomView> {
    const view = await this.toView(room);
    await this.repo.setCachedSnapshot(view, this.cacheTtl);
    return view;
  }

  /** Evict a room's live runtime state from Redis (cache, presence, trending). */
  private async clearRoomRuntime(roomId: string): Promise<void> {
    await this.repo.invalidateSnapshot(roomId);
    await this.repo.trendingRemove(roomId);
    const members = await this.presence.roomMembers(roomId);
    await Promise.all(members.map((userId) => this.presence.leaveRoom(roomId, userId)));
    const moderators = await this.presence.roomModerators(roomId);
    await Promise.all(moderators.map((userId) => this.presence.leaveRoom(roomId, userId, true)));
  }

  private roomNotFound(): BusinessException {
    return new BusinessException(
      ERROR_CODES.ROOM_NOT_FOUND,
      'Room not found.',
      HttpStatus.NOT_FOUND,
    );
  }
}
