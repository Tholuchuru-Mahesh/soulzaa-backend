import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  VideoRoom,
  VideoRoomCreationSource,
  VideoRoomLogAction,
  VideoRoomStatus,
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
  ) {
    this.config = loadVideoRoomConfig(config);
  }

  // ---- Create ----

  async create(actor: RoomActor, dto: CreateVideoRoomDto): Promise<VideoRoomDetailView> {
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

      const data: CreateVideoRoomData = {
        ownerId: actor.id,
        name: dto.name,
        description: dto.description ?? null,
        imageKey: dto.imageKey ?? null,
        categoryId: dto.categoryId ?? null,
        language: dto.language ?? null,
        country: dto.country ?? null,
        tags: dto.tags ?? [],
        visibility: dto.visibility ?? VideoRoomVisibility.PUBLIC,
        isLocked: passwordHash !== null,
        passwordHash,
        isDiscoverable: dto.isDiscoverable ?? true,
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
        ...(this.metadataFor(dto.accessPolicy) ?? {}),
      };

      const room = await this.repo.createRoomTx(data);
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
    if (dto.maxParticipants !== undefined) {
      assign(
        'maxParticipants',
        this.clamp(
          dto.maxParticipants,
          this.config.defaultMaxParticipants,
          this.config.maxParticipantsCap,
        ),
      );
    }
    if (dto.maxViewers !== undefined) {
      assign(
        'maxViewers',
        this.clamp(dto.maxViewers, this.config.defaultMaxViewers, this.config.maxViewersCap),
      );
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
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_ROOM);
    this.assertTransition(room.status, VideoRoomStatus.LIVE);
    await this.repo.updateRoom(roomId, { status: VideoRoomStatus.LIVE, endedAt: null }, actor.id);
    await this.repo.trendingBump(roomId);
    await this.repo.appendLog({
      roomId,
      actorId: actor.id,
      action: VideoRoomLogAction.UPDATED,
      metadata: { status: VideoRoomStatus.LIVE },
    });
    const view = await this.refreshCache(roomId);
    await this.events.emitRoomUpdated({ roomId, actorId: actor.id, changed: ['status'] });
    await this.events.emitRoomStarted({ roomId, ownerId: room.ownerId, actorId: actor.id });
    return view;
  }

  /** Close a room: -> ENDED. Owner-only (CLOSE_ROOM). Clears live runtime. */
  async close(actor: RoomActor, roomId: string): Promise<VideoRoomDetailView> {
    const room = await this.getRoomOrThrow(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.CLOSE_ROOM);
    this.assertTransition(room.status, VideoRoomStatus.ENDED);

    const durationSeconds = Math.max(0, Math.floor((Date.now() - room.createdAt.getTime()) / 1000));
    await this.repo.updateRoom(
      roomId,
      { status: VideoRoomStatus.ENDED, endedAt: new Date() },
      actor.id,
    );
    await this.repo.trendingRemove(roomId);
    await this.repo.clearCachedSnapshot(roomId);
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
}
