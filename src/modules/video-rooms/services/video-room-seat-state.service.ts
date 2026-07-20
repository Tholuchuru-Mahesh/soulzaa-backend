import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from 'src/infra/redis/cache.service';
import { loadVideoRoomConfig } from '../config/video-room.config';
import { videoRoomSeatStateKey } from '../constants/video-room.constants';
import type { SeatStageMutation, SeatStageSnapshot } from '../interfaces/seat-stage.interface';
import { seatRowToEntry } from '../mappers/video-room-seat-stage.mapper';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';

/**
 * Redis-authoritative, versioned live seat snapshot (VR-4) — the seat analogue of
 * `VideoRoomStateService`. The snapshot is the source of truth for reads + socket
 * sync; `rebuild` re-derives it from the durable `video_room_seats` projection when
 * the cache is cold. This service is a pure Redis primitive: it holds no business
 * rules and does NOT lock — the seat *services* own `videoRoomSeatLockKey` and call
 * `getSnapshot`/`rebuild`/`commit` inside it, so the version bump, DB write-through,
 * audit, and publish all happen atomically under one lock.
 */
@Injectable()
export class VideoRoomSeatStateService {
  private readonly ttl: number;

  constructor(
    private readonly cache: CacheService,
    private readonly seats: VideoRoomSeatsRepository,
    config: ConfigService,
  ) {
    this.ttl = loadVideoRoomConfig(config).stateTtlSeconds;
  }

  /** The cached live snapshot, or null when cold. */
  getSnapshot(roomId: string): Promise<SeatStageSnapshot | null> {
    return this.cache.get<SeatStageSnapshot>(videoRoomSeatStateKey(roomId));
  }

  /** Re-derive the snapshot from the durable projection (version reset to 1) + cache it. */
  async rebuild(roomId: string): Promise<SeatStageSnapshot> {
    const [layout, rows] = await Promise.all([
      this.seats.getSeatLayout(roomId),
      this.seats.listSeats(roomId),
    ]);
    const snapshot: SeatStageSnapshot = {
      roomId,
      version: 1,
      updatedAt: new Date().toISOString(),
      hostSeatCount: layout.hostSeatCount,
      guestSeatCount: layout.guestSeatCount,
      seats: rows.map(seatRowToEntry),
    };
    await this.cache.set(videoRoomSeatStateKey(roomId), snapshot, this.ttl);
    return snapshot;
  }

  /**
   * Merge `patch` onto `base`, bump the monotonic version, and persist. NON-locking —
   * the caller must already hold `videoRoomSeatLockKey(roomId)`.
   */
  async commit(
    roomId: string,
    base: SeatStageSnapshot,
    patch: SeatStageMutation,
  ): Promise<SeatStageSnapshot> {
    const next: SeatStageSnapshot = {
      ...base,
      ...patch,
      roomId,
      version: base.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.cache.set(videoRoomSeatStateKey(roomId), next, this.ttl);
    return next;
  }

  /** Drop the live snapshot (room closed / reset); DB history is retained. */
  async clear(roomId: string): Promise<void> {
    await this.cache.del(videoRoomSeatStateKey(roomId));
  }
}
