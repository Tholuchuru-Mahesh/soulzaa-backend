import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from 'src/infra/redis/cache.service';
import { loadVideoRoomConfig } from '../config/video-room.config';
import { buildSeatLayout } from '../constants/video-room-seat-lifecycle';
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

  /**
   * Re-derive the snapshot from the durable projection (version reset to 1) + cache it.
   *
   * Self-heals a room whose layout was never materialised. `VideoRoomSettings`
   * *declares* the layout (`hostSeatCount`/`guestSeatCount`, 9/0 by default) but
   * the authoritative seats are the `video_room_seats` rows, and every room created
   * before that materialisation existed has zero rows — which projected to a stage
   * with no seats at all, so `findOpenSeat` threw SEAT_FULL on a visibly empty room.
   * When the projection is empty but the room declares seats, materialise the layout
   * and re-read before projecting.
   *
   * Safe under `videoRoomSeatLockKey(roomId)` (which `mutateStage` holds around its
   * `rebuild` call): `createLayout` is a single plain Prisma `createMany` that
   * acquires no lock, so it cannot re-enter the non-reentrant Redis lock, and its
   * `skipDuplicates` + the (roomId,seatIndex) unique index make it idempotent for the
   * unlocked callers (`getStage`, viewer presence, media) that race alongside it.
   */
  async rebuild(roomId: string): Promise<SeatStageSnapshot> {
    const [layout, existing] = await Promise.all([
      this.seats.getSeatLayout(roomId),
      this.seats.listSeats(roomId),
    ]);
    // `hasSettings` gate: without it an unknown room id would fall back to the
    // platform defaults and have seat rows written for a room that never existed.
    const needsLayout =
      existing.length === 0 &&
      layout.hasSettings &&
      layout.hostSeatCount + layout.guestSeatCount > 0;
    let rows = existing;
    if (needsLayout) {
      await this.seats.createLayout(
        roomId,
        buildSeatLayout(layout.hostSeatCount, layout.guestSeatCount),
        null,
      );
      rows = await this.seats.listSeats(roomId);
    }
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
