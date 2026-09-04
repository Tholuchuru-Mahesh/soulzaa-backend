import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  VideoRoom,
  VideoRoomCreationSource,
  VideoRoomLogAction,
  VideoRoomStatus,
  VideoRoomStreamingStatus,
  VideoRoomVisibility,
} from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomConfig, VideoRoomConfig } from '../config/video-room.config';
import { VideoRoomAccessPolicy, isValidStatusTransition } from '../constants/video-room-lifecycle';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { videoRoomCreateLockKey } from '../constants/video-room.constants';
import type { CreateVideoRoomDto } from '../dto/create-video-room.dto';
import type { LockVideoRoomDto } from '../dto/lock-video-room.dto';
import type { UpdateVideoRoomDto } from '../dto/update-video-room.dto';
import type { VideoRoomDetailView } from '../entities/video-room-detail.view';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { toVideoRoomDetailView } from '../mappers/video-room-detail.mapper';
import {
  CreateVideoRoomData,
  UpdateVideoRoomData,
  VideoRoomsRepository,
} from '../repositories/video-rooms.repository';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import { VideoRoomEventService } from './video-room-event.service';
import { VideoRoomPasswordService } from './video-room-password.service';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomPresenceService } from './video-room-presence.service';
import { VideoRoomSeatStateService } from './video-room-seat-state.service';
import { VideoRoomSessionService } from './video-room-session.service';
import { VideoRoomStateService } from './video-room-state.service';
import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';
import { BroadBanService } from 'src/modules/platform-moderation/services/broad-ban.service';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';

/** The extended access policies that are persisted in metadata (not base visibility). */
const METADATA_ACCESS_POLICIES: ReadonlySet<VideoRoomAccessPolicy> = new Set([
  VideoRoomAccessPolicy.PASSWORD,
  VideoRoomAccessPolicy.INVITE_ONLY,
  VideoRoomAccessPolicy.FOLLOWERS_ONLY,
  VideoRoomAccessPolicy.FRIENDS_ONLY,
  VideoRoomAccessPolicy.VIP_ONLY,
]);

/** The lock fields a lock/update change touches. */
interface LockPatch {
  isLocked?: boolean;
  passwordHash?: string | null;
}

/**
 * The write side of the video-room lifecycle (VR-2, CQRS-ready): create, update,
 * lock/unlock, activate, close, reopen, soft-delete, restore. Every command
 * authorises through {@link VideoRoomPermissionService}, mutates through the
 * repository, keeps the Redis read-cache + trending set in sync, appends an
 * immutable audit log, and publishes a domain event (relayed to the socket
 * namespace by the listener). Status transitions are validated by the pure
 * `isValidStatusTransition` table — illegal transitions throw
 * `VIDEO_ROOM_INVALID_STATE`. No media / seats / participants (later phases).
 */
@Injectable()
export class VideoRoomLifecycleService {
  private readonly logger = new Logger(VideoRoomLifecycleService.name);
  private readonly config: VideoRoomConfig;

  constructor(
    private readonly repo: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly events: VideoRoomEventService,
    private readonly passwords: VideoRoomPasswordService,
    private readonly locks: LockService,
    config: ConfigService,
    private readonly metrics: VideoRoomsMetrics,
    private readonly seats: VideoRoomSeatStateService,
    private readonly presence: VideoRoomPresenceService,
    private readonly sessions: VideoRoomSessionService,
    private readonly state: VideoRoomStateService,
    @Optional() private readonly platformBans?: PlatformBanService,
    @Optional() private readonly broadBans?: BroadBanService,
    @Optional() private readonly chatRepo?: VideoRoomChatRepository,
    @Optional() private readonly chatCache?: VideoRoomChatCacheService,
  ) {
    this.config = loadVideoRoomConfig(config);
  }

  // ---- Create ----

  async create(actor: RoomActor, dto: CreateVideoRoomDto): Promise<VideoRoomDetailView> {
    const isModeratorActor = (actor.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );
    if (!isModeratorActor && this.platformBans) {
      await this.platformBans.assertNotGloballyBanned(actor.id);
    }
    if (!isModeratorActor && this.broadBans) {
      await this.broadBans.assertNotBroadBanned(actor.id);
    }
    return this.locks.withLock(videoRoomCreateLockKey(actor.id), async () => {
      // Allow host to create new rooms freely without 1-room cap constraint
      // const active = await this.repo.countActiveByOwner(actor.id);
      // if (active >= this.config.maxRoomsPerOwner) {
      //   throw new BusinessException(
      //     ERROR_CODES.VIDEO_ROOM_ALREADY_EXISTS,
      //     `You may host at most ${this.config.maxRoomsPerOwner} room(s) at a time.`,
      //     HttpStatus.CONFLICT,
      //   );
      // }

      const wantsPassword =
        dto.accessPolicy === VideoRoomAccessPolicy.PASSWORD || dto.password !== undefined;
      if (wantsPassword && !dto.password) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_CONFIG_INVALID,
          'A password is required to create a password-protected room.',
          HttpStatus.BAD_REQUEST,
        );
      }
      const passwordHash = dto.password ? await this.passwords.hash(dto.password) : null;

      const isUuid = (id?: string | null): boolean =>
        typeof id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

      // Rooms are permanent and one-per-owner (matching Audio Room architecture).
      // If the owner already has a room, "create" means "update details & reactivate as LIVE".
      const ownedRooms = await this.repo.findByOwnerId(actor.id);
      const existing = ownedRooms.length > 0 ? ownedRooms[0] : null;
      if (existing) {
        const paidEntry = this.resolvePaidEntry(dto, existing);
        const updateData: UpdateVideoRoomData = {
          name: dto.name,
          description: dto.description ?? null,
          imageKey: dto.imageKey ?? existing.imageKey,
          categoryId: isUuid(dto.categoryId)
            ? dto.categoryId!
            : dto.categoryId === null
              ? null
              : existing.categoryId,
          language: dto.language ?? existing.language,
          country: dto.country ?? existing.country,
          tags: dto.tags ?? existing.tags ?? [],
          visibility: dto.visibility ?? VideoRoomVisibility.PUBLIC,
          isLocked: passwordHash !== null,
          passwordHash: passwordHash ?? (wantsPassword ? existing.passwordHash : null),
          isDiscoverable: dto.isDiscoverable ?? true,
          paidEntryEnabled: paidEntry.paidEntryEnabled,
          defaultEntryFee: paidEntry.defaultEntryFee,
          status: VideoRoomStatus.LIVE,
          streamingStatus: VideoRoomStreamingStatus.IDLE,
          endedAt: null,
          ...(this.metadataFor(dto.accessPolicy) ?? {}),
        };

        if (dto.maxParticipants !== undefined) {
          updateData.maxParticipants = this.clamp(
            dto.maxParticipants,
            this.config.defaultMaxParticipants,
            this.config.maxParticipantsCap,
          );
        }
        if (dto.maxViewers !== undefined) {
          updateData.maxViewers = this.clamp(
            dto.maxViewers,
            this.config.defaultMaxViewers,
            this.config.maxViewersCap,
          );
        }

        await this.repo.updateRoom(existing.id, updateData, actor.id);

        // Going LIVE from a non-LIVE state always starts from a clean slate —
        // regardless of *why* the room's live runtime still has stale
        // members/sessions/viewer counts sitting in it (a prior close() that
        // predates this cleanup, a crash that skipped close() entirely, a
        // manual DB/test-data write). Trusting "close() already cleaned up"
        // is what let 20 long-dead members reappear the moment this same
        // owner started a new broadcast. Guarded on the PREVIOUS status (not
        // run when the room was already LIVE) so a redundant "start" tap on a
        // genuinely-live room never evicts the real viewers currently in it.
        if (existing.status !== VideoRoomStatus.LIVE) {
          await this.resetLiveRuntime(existing.id, actor.id);
          if (this.chatRepo) {
            await this.chatRepo.softDeleteRoomMessages(existing.id, actor.id);
          }
          if (this.chatCache) {
            await this.chatCache.invalidateRecent(existing.id);
            await this.chatCache.setPins(existing.id, []);
          }
        }

        await this.repo.createBroadcastSession(existing.id, actor.id, {
          title: dto.name,
          topic: dto.description,
          imageKey: dto.imageKey,
          paidEntryEnabled: paidEntry.paidEntryEnabled,
          entryFee: paidEntry.defaultEntryFee,
        });

        // Rooms are one-per-owner, so "create" for an existing owner is really
        // "reopen with these details" — and that makes THIS the branch a seat
        // choice normally travels through, not the create branch below. Without
        // it the stage size picked on the create screen was silently dropped
        // for every returning host, which is most of them.
        if (dto.hostSeatCount !== undefined || dto.guestSeatCount !== undefined) {
          await this.seats.applyDeclaredLayout(
            existing.id,
            dto.hostSeatCount,
            dto.guestSeatCount,
            actor.id,
          );
        }

        await this.repo.trendingBump(existing.id);
        const view = await this.refreshCache(existing.id);

        try {
          await this.repo.appendLog({
            roomId: existing.id,
            actorId: actor.id,
            action: VideoRoomLogAction.UPDATED,
            metadata: { status: VideoRoomStatus.LIVE, reopened: true },
          });
        } catch (err) {
          this.logger.warn(
            `Failed to append log for room ${existing.id}: ${(err as Error).message}`,
          );
        }

        try {
          await this.events.emitRoomUpdated({
            roomId: existing.id,
            actorId: actor.id,
            changed: ['status', 'name', 'imageKey', 'visibility', 'paidEntryEnabled'],
          });
        } catch (err) {
          this.logger.warn(
            `Failed to emit RoomUpdated for room ${existing.id}: ${(err as Error).message}`,
          );
        }

        try {
          await this.events.emitRoomStarted({
            roomId: existing.id,
            ownerId: existing.ownerId,
            actorId: actor.id,
          });
        } catch (err) {
          this.logger.warn(
            `Failed to emit RoomStarted for room ${existing.id}: ${(err as Error).message}`,
          );
        }

        this.logger.log(
          `Video room ${existing.id} reactivated/started with new broadcast session by ${actor.id}`,
        );
        return view;
      }

      const newPaidEntry = this.resolvePaidEntry(dto, null);
      const data: CreateVideoRoomData = {
        ownerId: actor.id,
        name: dto.name,
        description: dto.description ?? null,
        imageKey: dto.imageKey ?? null,
        categoryId: isUuid(dto.categoryId) ? dto.categoryId! : null,
        language: dto.language ?? null,
        country: dto.country ?? null,
        tags: dto.tags ?? [],
        visibility: dto.visibility ?? VideoRoomVisibility.PUBLIC,
        isLocked: passwordHash !== null,
        passwordHash,
        isDiscoverable: dto.isDiscoverable ?? true,
        paidEntryEnabled: newPaidEntry.paidEntryEnabled,
        defaultEntryFee: newPaidEntry.defaultEntryFee,
        maxParticipants: this.clamp(
          dto.maxParticipants,
          this.config.defaultMaxParticipants,
          this.config.maxParticipantsCap,
        ),
        maxViewers: this.clamp(
          dto.maxViewers,
          this.config.defaultMaxViewers,
          this.config.maxViewersCap,
        ),
        creationSource: VideoRoomCreationSource.APP,
        // The stage size the creator chose. Undefined ⇒ the repository's
        // platform default; passing it through is what makes the Seats page
        // show the capacity the room was actually created with.
        hostSeatCount: dto.hostSeatCount,
        guestSeatCount: dto.guestSeatCount,
        ...(this.metadataFor(dto.accessPolicy) ?? {}),
      };

      const room = await this.repo.createRoomTx(data);
      await this.repo.createBroadcastSession(room.id, actor.id, {
        title: dto.name,
        topic: dto.description,
        imageKey: dto.imageKey,
        paidEntryEnabled: newPaidEntry.paidEntryEnabled,
        entryFee: newPaidEntry.defaultEntryFee,
      });
      await this.repo.trendingBump(room.id);
      const view = await this.refreshCache(room.id);
      await this.events.emitRoomCreated({
        roomId: room.id,
        ownerId: room.ownerId,
        name: room.name,
        categoryId: room.categoryId,
        language: room.language,
        visibility: room.visibility,
      });
      this.metrics.incCreated();
      this.logger.log(`Video room ${room.id} created by ${actor.id}`);
      return view;
    });
  }

  // ---- Update ----

  async update(
    actor: RoomActor,
    roomId: string,
    dto: UpdateVideoRoomDto,
  ): Promise<VideoRoomDetailView> {
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_ROOM);

    const data: UpdateVideoRoomData = {};
    const changed: string[] = [];
    const assign = <K extends keyof UpdateVideoRoomData>(
      key: K,
      value: UpdateVideoRoomData[K] | undefined,
    ): void => {
      if (value !== undefined) {
        data[key] = value;
        changed.push(key);
      }
    };

    assign('name', dto.name);
    assign('description', dto.description ?? undefined);
    assign('imageKey', dto.imageKey ?? undefined);
    assign('categoryId', dto.categoryId ?? undefined);
    assign('language', dto.language ?? undefined);
    assign('country', dto.country ?? undefined);
    assign('tags', dto.tags);
    assign('visibility', dto.visibility);
    assign('isDiscoverable', dto.isDiscoverable);
    // An EXPLICIT update is rejected when it exceeds the cap, not silently
    // clamped. Clamping is right for create (an absent value takes the
    // default), but on an update the caller typed a number and watched a
    // different one come back with no explanation — "I set 50 and it became
    // 20". A 400 naming the ceiling is something the UI can actually show.
    if (dto.maxParticipants !== undefined) {
      this.assertWithinCap(dto.maxParticipants, this.config.maxParticipantsCap, 'maxParticipants');
      assign('maxParticipants', dto.maxParticipants);
    }
    if (dto.maxViewers !== undefined) {
      this.assertWithinCap(dto.maxViewers, this.config.maxViewersCap, 'maxViewers');
      assign('maxViewers', dto.maxViewers);
    }
    if (dto.accessPolicy !== undefined) {
      const meta = this.metadataFor(dto.accessPolicy);
      if (meta) {
        data.metadata = meta.metadata;
        changed.push('accessPolicy');
      }
    }

    // Lock can also be toggled through PATCH; delegate to the same rules as lock().
    const lockPatch = await this.computeLockPatch(room, dto.isLocked, dto.password);
    const lockChanged = lockPatch.isLocked !== undefined;
    if (lockChanged) {
      Object.assign(data, lockPatch);
      changed.push('isLocked');
    }

    if (
      dto.paidEntryEnabled !== undefined ||
      dto.entryFee !== undefined ||
      dto.defaultEntryFee !== undefined
    ) {
      const paidEntry = this.resolvePaidEntry(dto, room);
      assign('paidEntryEnabled', paidEntry.paidEntryEnabled);
      assign('defaultEntryFee', paidEntry.defaultEntryFee);
    }

    await this.repo.updateRoom(roomId, data, actor.id);

    if (changed.includes('imageKey')) {
      await this.repo.appendLog({
        roomId,
        actorId: actor.id,
        action: VideoRoomLogAction.IMAGE_UPDATED,
      });
    }
    if (lockChanged) {
      await this.repo.appendLog({
        roomId,
        actorId: actor.id,
        action: lockPatch.isLocked ? VideoRoomLogAction.LOCKED : VideoRoomLogAction.UNLOCKED,
      });
      await this.events.emitRoomLocked({
        roomId,
        actorId: actor.id,
        isLocked: !!lockPatch.isLocked,
      });
    }
    await this.repo.appendLog({
      roomId,
      actorId: actor.id,
      action: VideoRoomLogAction.UPDATED,
      metadata: { changed },
    });
    const view = await this.refreshCache(roomId);
    await this.events.emitRoomUpdated({ roomId, actorId: actor.id, changed });
    return view;
  }

  // ---- Lock / unlock ----

  async lock(
    actor: RoomActor,
    roomId: string,
    dto: LockVideoRoomDto,
  ): Promise<VideoRoomDetailView> {
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.LOCK_ROOM);

    if (room.isLocked && !dto.password) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_ALREADY_LOCKED,
        'This room is already locked.',
        HttpStatus.CONFLICT,
      );
    }
    const patch = await this.computeLockPatch(room, true, dto.password);
    await this.repo.updateRoom(roomId, patch, actor.id);
    await this.repo.appendLog({ roomId, actorId: actor.id, action: VideoRoomLogAction.LOCKED });
    const view = await this.refreshCache(roomId);
    await this.events.emitRoomLocked({ roomId, actorId: actor.id, isLocked: true });
    this.metrics.incLocked();
    return view;
  }

  async unlock(actor: RoomActor, roomId: string): Promise<VideoRoomDetailView> {
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.LOCK_ROOM);
    await this.repo.updateRoom(roomId, { isLocked: false, passwordHash: null }, actor.id);
    await this.repo.appendLog({ roomId, actorId: actor.id, action: VideoRoomLogAction.UNLOCKED });
    const view = await this.refreshCache(roomId);
    await this.events.emitRoomLocked({ roomId, actorId: actor.id, isLocked: false });
    return view;
  }

  // ---- Status transitions ----

  /** Activate a room: OFFLINE -> LIVE (go live). */
  async activate(actor: RoomActor, roomId: string): Promise<VideoRoomDetailView> {
    const isModeratorActor = (actor.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );
    if (!isModeratorActor && this.platformBans) {
      await this.platformBans.assertNotGloballyBanned(actor.id);
    }
    if (!isModeratorActor && this.broadBans) {
      await this.broadBans.assertNotBroadBanned(actor.id);
    }
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_ROOM);
    this.assertTransition(room.status, VideoRoomStatus.LIVE);
    await this.repo.updateRoom(roomId, { status: VideoRoomStatus.LIVE, endedAt: null }, actor.id);
    await this.repo.createBroadcastSession(roomId, actor.id, {
      title: room.name,
      topic: room.description,
      imageKey: room.imageKey,
    });
    await this.repo.trendingBump(roomId);
    await this.repo.appendLog({
      roomId,
      actorId: actor.id,
      action: VideoRoomLogAction.UPDATED,
      metadata: { status: VideoRoomStatus.LIVE },
    });
    const view = await this.refreshCache(roomId);
    await this.resetLiveRuntime(roomId, actor.id);
    if (this.chatRepo) {
      await this.chatRepo.softDeleteRoomMessages(roomId, actor.id);
    }
    if (this.chatCache) {
      await this.chatCache.invalidateRecent(roomId);
      await this.chatCache.setPins(roomId, []);
    }
    await this.events.emitRoomUpdated({ roomId, actorId: actor.id, changed: ['status'] });
    await this.events.emitRoomStarted({ roomId, ownerId: room.ownerId, actorId: actor.id });
    return view;
  }

  /** Close a room: -> ENDED. Owner-only (CLOSE_ROOM). Clears live runtime & ends broadcast session. */
  async close(actor: RoomActor, roomId: string): Promise<VideoRoomDetailView> {
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.CLOSE_ROOM);
    this.assertTransition(room.status, VideoRoomStatus.ENDED);

    const durationSeconds = Math.max(0, Math.floor((Date.now() - room.createdAt.getTime()) / 1000));
    await this.repo.endActiveBroadcastSession(roomId, 'HOST_ENDED');
    await this.repo.updateRoom(
      roomId,
      { status: VideoRoomStatus.ENDED, endedAt: new Date() },
      actor.id,
    );
    await this.repo.trendingRemove(roomId);
    await this.repo.clearCachedSnapshot(roomId);
    if (this.chatRepo) {
      await this.chatRepo.softDeleteRoomMessages(roomId, actor.id);
    }
    if (this.chatCache) {
      await this.chatCache.invalidateRecent(roomId);
      await this.chatCache.setPins(roomId, []);
    }

    // Rooms are permanent and reused for the owner's next broadcast (see
    // `create()` above), so — unlike a one-shot resource — nothing else ever
    // deletes this room's live runtime state. Without tearing it down here,
    // every member/viewer who was still connected when the host force-ended
    // the room stays "active" in Redis/Postgres and reappears as a stale
    // roster/count/session the next time this same roomId goes live.
    await this.resetLiveRuntime(roomId, actor.id);

    await this.repo.appendLog({
      roomId,
      actorId: actor.id,
      action: VideoRoomLogAction.ENDED,
      metadata: { durationSeconds },
    });
    await this.events.emitRoomClosed({
      roomId,
      actorId: actor.id,
      ownerId: room.ownerId,
      durationSeconds,
    });
    return this.buildDetail(roomId);
  }

  /**
   * Tear down a room's live runtime — presence sets, socket sessions, active
   * member rows, and the cached counter snapshot. Called both when a room ends
   * AND whenever it goes (or goes back) LIVE: trusting that whatever put the
   * room in its current state already cleaned up after itself is exactly what
   * let stale members/viewers reappear the moment a room was reused — a crash
   * that skipped `close()`, or data written directly against the DB, leaves
   * this room-permanent/reusable model with no other guaranteed cleanup point.
   */
  private async resetLiveRuntime(roomId: string, actorId: string): Promise<void> {
    await this.presence.clearRoom(roomId);
    await this.sessions.endAllRoomSessions(roomId);
    await this.repo.deactivateAllMembers(roomId, actorId);
    await this.state.clear(roomId);
  }

  /** Reopen a closed room: ENDED -> OFFLINE (re-editable, ready to activate). */
  async reopen(actor: RoomActor, roomId: string): Promise<VideoRoomDetailView> {
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_ROOM);
    this.assertTransition(room.status, VideoRoomStatus.OFFLINE);
    await this.repo.updateRoom(
      roomId,
      { status: VideoRoomStatus.OFFLINE, endedAt: null },
      actor.id,
    );
    await this.repo.appendLog({
      roomId,
      actorId: actor.id,
      action: VideoRoomLogAction.UPDATED,
      metadata: { status: VideoRoomStatus.OFFLINE, reopened: true },
    });
    const view = await this.refreshCache(roomId);
    await this.events.emitRoomUpdated({ roomId, actorId: actor.id, changed: ['status'] });
    return view;
  }

  // ---- Delete / restore ----

  /** Soft-delete a room (owner-only). History retained; Redis runtime cleared. */
  async remove(actor: RoomActor, roomId: string): Promise<{ deleted: true }> {
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.CLOSE_ROOM);
    await this.repo.softDelete(roomId, actor.id);
    await this.repo.clearCachedSnapshot(roomId);
    await this.repo.trendingRemove(roomId);
    await this.repo.appendLog({ roomId, actorId: actor.id, action: VideoRoomLogAction.DELETED });
    await this.events.emitRoomDeleted({ roomId, actorId: actor.id, ownerId: room.ownerId });
    this.metrics.incDeleted();
    this.logger.log(`Video room ${roomId} soft-deleted by ${actor.id}`);
    return { deleted: true };
  }

  /** Restore a soft-deleted room to a fresh OFFLINE state. */
  async restore(actor: RoomActor, roomId: string): Promise<VideoRoomDetailView> {
    const room = await this.repo.findDeletedById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `No deleted video room ${roomId} to restore.`,
        HttpStatus.NOT_FOUND,
      );
    }
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_ROOM);
    await this.repo.restore(roomId, actor.id);
    await this.repo.appendLog({
      roomId,
      actorId: actor.id,
      action: VideoRoomLogAction.UPDATED,
      metadata: { restored: true },
    });
    const view = await this.refreshCache(roomId);
    await this.events.emitRoomRestored({ roomId, actorId: actor.id, ownerId: room.ownerId });
    return view;
  }

  // ---- Helpers ----

  private async getRoomOrThrow(roomId: string): Promise<VideoRoom> {
    const room = await this.repo.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return room;
  }

  private assertTransition(from: VideoRoomStatus, to: VideoRoomStatus): void {
    if (!isValidStatusTransition(from, to)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
        `Cannot transition a room from ${from} to ${to}.`,
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Resolve the lock fields for an update/lock. Returns `{}` (no change) when
   * neither `isLocked` nor `password` is supplied. Locking requires a password —
   * a new one, or an existing hash on the room.
   */
  private async computeLockPatch(
    room: VideoRoom,
    isLocked: boolean | undefined,
    password: string | undefined,
  ): Promise<LockPatch> {
    if (isLocked === undefined && password === undefined) return {};
    if (isLocked === false) return { isLocked: false, passwordHash: null };
    // isLocked true (explicitly, or implied by supplying a password).
    if (password) return { isLocked: true, passwordHash: await this.passwords.hash(password) };
    if (room.passwordHash) return { isLocked: true };
    throw new BusinessException(
      ERROR_CODES.VIDEO_ROOM_CONFIG_INVALID,
      'A password is required to lock this room.',
      HttpStatus.BAD_REQUEST,
    );
  }

  /** Extended access policies persist in metadata; base PUBLIC/PRIVATE do not. */
  private metadataFor(
    policy: VideoRoomAccessPolicy | undefined,
  ): { metadata: Prisma.InputJsonValue } | null {
    if (policy && METADATA_ACCESS_POLICIES.has(policy)) {
      return { metadata: { accessPolicy: policy } };
    }
    return null;
  }

  /** Reject an explicit over-cap value with a message naming the ceiling. */
  private assertWithinCap(requested: number, cap: number, field: string): void {
    if (requested > cap) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        `${field} cannot exceed ${cap}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private clamp(requested: number | undefined, fallback: number, cap: number): number {
    const value = requested ?? fallback;
    return Math.min(cap, Math.max(0, value));
  }

  /** Rebuild + cache the detail view (read-through cache stays warm after a write). */
  private async refreshCache(roomId: string): Promise<VideoRoomDetailView> {
    const view = await this.buildDetail(roomId);
    await this.repo.setCachedSnapshot(roomId, view, this.config.cacheTtlSeconds);
    return view;
  }

  /** Build the detail view for a room (no caching). */
  private async buildDetail(roomId: string): Promise<VideoRoomDetailView> {
    const detail = await this.repo.findDetail(roomId);
    if (!detail) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return toVideoRoomDetailView(detail);
  }

  private resolvePaidEntry(
    dto: { paidEntryEnabled?: boolean; entryFee?: number; defaultEntryFee?: number },
    existing?: any,
  ): { paidEntryEnabled: boolean; defaultEntryFee: bigint | null } {
    const rawPaidEnabled = dto.paidEntryEnabled !== undefined
      ? dto.paidEntryEnabled
      : existing?.paidEntryEnabled ?? false;

    const rawFee = dto.entryFee ?? dto.defaultEntryFee;
    let finalFee: bigint | null = null;

    if (rawPaidEnabled) {
      const candidateFee = rawFee !== undefined
        ? rawFee
        : existing?.defaultEntryFee !== undefined && existing?.defaultEntryFee !== null
          ? Number(existing.defaultEntryFee)
          : null;

      if (candidateFee === null || candidateFee === undefined) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_CONFIG_INVALID,
          `An entry fee between ${this.config.minEntryFee} and ${this.config.maxEntryFee} Gold Coins is required when Paid Entry is enabled.`,
          HttpStatus.BAD_REQUEST,
        );
      }

      if (
        !Number.isInteger(candidateFee) ||
        candidateFee < this.config.minEntryFee ||
        candidateFee > this.config.maxEntryFee
      ) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_CONFIG_INVALID,
          `Entry fee must be an integer between ${this.config.minEntryFee} and ${this.config.maxEntryFee} Gold Coins.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      finalFee = BigInt(candidateFee);
    } else {
      if (rawFee !== undefined && rawFee !== null) {
        finalFee = BigInt(rawFee);
      } else if (existing?.defaultEntryFee !== undefined && existing?.defaultEntryFee !== null) {
        finalFee = BigInt(existing.defaultEntryFee);
      }
    }

    return {
      paidEntryEnabled: rawPaidEnabled,
      defaultEntryFee: finalFee,
    };
  }
}
