import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomConfig } from '../config/video-room.config';
import { videoRoomStateKey, videoRoomStateLockKey } from '../constants/video-room.constants';
import type {
  IRoomStateManager,
  VideoRoomStateMutation,
  VideoRoomStateSnapshot,
} from '../interfaces/room-state-manager.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';

/**
 * Centralised, versioned room-state manager (VR-0 foundation primitive). The
 * live snapshot is authoritative in Redis; `applyUpdate` serialises writes with
 * a per-room distributed lock and bumps a monotonic `version` so concurrent
 * writers cannot lose an update and clients can reconcile out-of-order syncs.
 * `restore` rebuilds the snapshot from the durable record for recovery. No room
 * business rules live here — later phases pass mutators that encode them.
 */
@Injectable()
export class VideoRoomStateService implements IRoomStateManager {
  private readonly logger = new Logger(VideoRoomStateService.name);
  private readonly stateTtl: number;

  constructor(
    private readonly cache: CacheService,
    private readonly locks: LockService,
    private readonly repo: VideoRoomsRepository,
    config: ConfigService,
  ) {
    this.stateTtl = loadVideoRoomConfig(config).stateTtlSeconds;
  }

  async getSnapshot(roomId: string): Promise<VideoRoomStateSnapshot | null> {
    return this.cache.get<VideoRoomStateSnapshot>(videoRoomStateKey(roomId));
  }

  async applyUpdate(
    roomId: string,
    mutate: (current: VideoRoomStateSnapshot) => VideoRoomStateMutation,
  ): Promise<VideoRoomStateSnapshot> {
    return this.locks.withLock(videoRoomStateLockKey(roomId), async () => {
      const current = (await this.getSnapshot(roomId)) ?? (await this.restore(roomId));
      if (!current) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
          'No room state to update — the room does not exist.',
          HttpStatus.CONFLICT,
        );
      }
      const changes = mutate(current);
      const next: VideoRoomStateSnapshot = {
        ...current,
        ...changes,
        roomId,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.cache.set(videoRoomStateKey(roomId), next, this.stateTtl);
      return next;
    });
  }

  async restore(roomId: string): Promise<VideoRoomStateSnapshot | null> {
    const room = await this.repo.findById(roomId);
    if (!room) return null;
    // Counts start at zero on rebuild; they are re-accrued by applyUpdate as
    // sessions register/leave (VR-0 has no live join flow to seed them).
    const snapshot: VideoRoomStateSnapshot = {
      roomId: room.id,
      version: 1,
      status: room.status,
      participantCount: 0,
      viewerCount: 0,
      hostCount: 0,
      onlineCount: 0,
      reconnectingCount: 0,
      idleCount: 0,
      isLocked: room.giftLockEnabled,
      updatedAt: new Date().toISOString(),
    };
    await this.cache.set(videoRoomStateKey(roomId), snapshot, this.stateTtl);
    return snapshot;
  }

  async clear(roomId: string): Promise<void> {
    await this.cache.del(videoRoomStateKey(roomId));
  }
}
