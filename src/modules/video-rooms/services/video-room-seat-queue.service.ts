import { Inject, Injectable, Logger } from '@nestjs/common';
import { VideoRoomSeatRequestStatus } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import { WEALTH_SERVICE, type IWealthService } from 'src/modules/wealth/interfaces/wealth.service.interface';
import type { SeatStageView } from '../entities/video-room-seat-stage.view';
import {
  computeQueueScore,
  videoRoomSeatQueueKey,
  videoRoomSeatQueueSkipsKey,
} from '../constants/video-room-seat-queue';
import {
  VIDEO_ROOM_QUEUE_PREVIEW_LIMIT,
  VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS,
  videoRoomSeatQueueLockKey,
} from '../constants/video-room.constants';
import {
  SeatQueueUpdatedEvent,
  SeatRequestResolvedEvent,
  type QueuePreviewEntry,
} from '../events/video-room-seat.events';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
import { VideoRoomSeatService } from './video-room-seat.service';

/** One ordered entry in a room's seat queue. */
export interface QueueEntryView {
  userId: string;
  /** 1-based position (Redis ranks are 0-based; the conversion happens here). */
  position: number;
  vipLevel: number;
  score: number;
}

/**
 * VR-8 — the seat queue, as a Redis ZSET projection over the PENDING rows in
 * `video_room_seat_requests`.
 *
 * Postgres remains the record of truth: this projection is rebuildable at any
 * time from `listPendingRequests`, and every read path checks for its presence
 * first (`rebuild`-on-miss), so a Redis flush or failover costs a rebuild rather
 * than a room's queue. Ordering policy lives entirely in the pure
 * `computeQueueScore`; this service only projects and reads.
 *
 * Sole publisher of `SeatQueueUpdatedEvent`.
 */
@Injectable()
export class VideoRoomSeatQueueService {
  private readonly logger = new Logger(VideoRoomSeatQueueService.name);

  constructor(
    private readonly cache: CacheService,
    private readonly seats: VideoRoomSeatsRepository,
    @Inject(WEALTH_SERVICE) private readonly wealth: IWealthService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly seatSvc: VideoRoomSeatService,
    private readonly locks: LockService,
    private readonly events: VideoRoomEventsRepository,
  ) {}

  /** Add (or re-score) a user in the room queue. Returns their 1-based position. */
  async enqueue(roomId: string, userId: string, createdAt: Date): Promise<number> {
    await this.ensureProjection(roomId);
    const score = await this.scoreFor(roomId, userId, createdAt);
    const key = videoRoomSeatQueueKey(roomId);
    await this.cache.setScore(key, userId, score);
    await this.cache.expire(key, VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS);
    await this.broadcastUpdate(roomId);
    return (await this.rawPosition(roomId, userId)) ?? 1;
  }

  /** Remove a user from the queue and forget their skip history. */
  async dequeue(roomId: string, userId: string): Promise<void> {
    await this.ensureProjection(roomId);
    const key = videoRoomSeatQueueKey(roomId);
    await this.cache.sortedRemove(key, userId);
    await this.cache.sortedRemove(videoRoomSeatQueueSkipsKey(roomId), userId);
    await this.cache.expire(key, VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS);
    await this.broadcastUpdate(roomId);
  }

  /** A user's 1-based queue position, or null when they are not queued. */
  async position(roomId: string, userId: string): Promise<number | null> {
    await this.ensureProjection(roomId);
    return this.rawPosition(roomId, userId);
  }

  /** The ordered queue, front first, bounded by `limit`. */
  async list(roomId: string, limit = VIDEO_ROOM_QUEUE_PREVIEW_LIMIT): Promise<QueueEntryView[]> {
    await this.ensureProjection(roomId);
    const rows = await this.cache.sortedLowest(videoRoomSeatQueueKey(roomId), limit);
    return Promise.all(
      rows.map(async (row, index) => ({
        userId: row.member,
        position: index + 1,
        vipLevel: await this.vipLevel(row.member),
        score: row.score,
      })),
    );
  }

  /** How many users are waiting. */
  async size(roomId: string): Promise<number> {
    await this.ensureProjection(roomId);
    return this.cache.sortedCount(videoRoomSeatQueueKey(roomId));
  }

  /**
   * Room-live + active-member gate for the `GET .../seats/queue` read route.
   * Every other seat-queue route is either MANAGE_SEATS-gated (`listRequests`)
   * or scoped to the invitee/requester themselves; this one is deliberately
   * open to any active member so they can see their own position — but absent
   * a check here the only gate was the JWT guard, letting any authenticated
   * non-guest enumerate an arbitrary room's waiting list. Mirrors the checks
   * `VideoRoomSeatRequestService.request` performs before enqueueing.
   */
  async assertQueueAccess(roomId: string, userId: string): Promise<void> {
    await this.seatSvc.requireLiveRoom(roomId);
    await this.seatSvc.assertActiveMember(roomId, userId);
  }

  /** Drop the whole projection (room ended / deleted). */
  async clear(roomId: string): Promise<void> {
    await this.cache.del(videoRoomSeatQueueKey(roomId), videoRoomSeatQueueSkipsKey(roomId));
  }

  /**
   * Replay every PENDING request into the ZSET. Idempotent — `setScore` is a
   * ZADD, so re-running simply re-writes the same scores.
   */
  async rebuild(roomId: string): Promise<number> {
    const pending = await this.seats.listPendingRequests(roomId);
    if (pending.length === 0) return 0;
    const key = videoRoomSeatQueueKey(roomId);
    await Promise.all(
      pending.map(async (req) => {
        const score = await this.scoreFor(roomId, req.userId, req.createdAt);
        await this.cache.setScore(key, req.userId, score);
      }),
    );
    await this.cache.expire(key, VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS);
    this.logger.debug(`Rebuilt seat queue for room ${roomId}: ${pending.length} entr(ies)`);
    return pending.length;
  }

  /** Broadcast the current queue shape (size + bounded preview). */
  async publishUpdate(roomId: string): Promise<void> {
    await this.ensureProjection(roomId);
    await this.broadcastUpdate(roomId);
  }

  /**
   * Auto-promote the front of the queue onto a freed seat.
   *
   * Runs under the room's dedicated QUEUE lock — never the seat lock, which
   * `seatUser` takes for itself and which `LockService` cannot re-enter — so two
   * concurrent seat-freed events can't double-book one seat index.
   *
   * Makes exactly ONE pass over the queue preview: a candidate who cannot be
   * seated (seat re-taken, request already resolved, block in force) has their
   * skip counter incremented — which re-scores them toward the fairness pin —
   * and is passed over. Bounded so a poisoned queue can never spin. Only a
   * `BusinessException` thrown by `seatUser` counts as "this candidate cannot
   * be seated" — any other error (a Redis/Postgres outage, a lock-acquisition
   * timeout, etc.) propagates out of `advance` unchanged instead of being
   * charged to every remaining candidate's skip counter.
   *
   * @remarks
   * MUST NOT be called from a stack that already holds `videoRoomSeatLockKey`
   * for this room. `advance` seats candidates via `seatSvc.seatUser`, which
   * re-acquires that same seat lock through `mutateStage`, and `LockService`
   * locks are not re-entrant (`SET NX`) — a nested acquisition retries for
   * ~2.1s per candidate and then throws. Concretely,
   * `VideoRoomSeatService.applyVacate` publishes `SeatLeftEvent` from *inside*
   * its `withLock(videoRoomSeatLockKey(...))` block, and the in-memory event
   * bus awaits listeners synchronously on the publisher's stack — so any
   * listener that reacts to seat-lifecycle events by calling `advance` must
   * defer that call out of the publisher's stack (e.g. via a microtask/queue
   * hop) rather than invoking it inline from the event handler.
   *
   * @returns the userId seated, or null when nobody could take the seat.
   */
  async advance(roomId: string, seatIndex: number, actorId: string): Promise<string | null> {
    const seated = await this.locks.withLock(videoRoomSeatQueueLockKey(roomId), async () => {
      await this.ensureProjection(roomId);
      const key = videoRoomSeatQueueKey(roomId);
      const skipsKey = videoRoomSeatQueueSkipsKey(roomId);
      const candidates = await this.cache.sortedLowest(key, VIDEO_ROOM_QUEUE_PREVIEW_LIMIT);

      for (const candidate of candidates) {
        const userId = candidate.member;
        const request = await this.seats.findPendingRequest(roomId, userId);

        // Stale projection entry — the row is gone or already resolved.
        if (!request) {
          await this.cache.sortedRemove(key, userId);
          await this.cache.expire(key, VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS);
          continue;
        }

        let view: SeatStageView;
        try {
          view = await this.seatSvc.seatUser(roomId, userId, actorId, seatIndex, undefined);
        } catch (err) {
          if (!(err instanceof BusinessException)) throw err;
          this.logger.debug(`Queue advance skipped ${userId} in room ${roomId}: ${err.message}`);
          await this.cache.addScore(skipsKey, userId, 1);
          await this.cache.expire(skipsKey, VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS);
          await this.reScore(roomId, userId, request.createdAt);
          await this.cache.expire(key, VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS);
          continue;
        }

        await this.seats.setRequestStatus(
          request.id,
          VideoRoomSeatRequestStatus.PROMOTED,
          actorId,
          actorId,
          { bumpAttempt: true, lastError: null },
        );
        await this.cache.sortedRemove(key, userId);
        await this.cache.sortedRemove(skipsKey, userId);
        await this.cache.expire(key, VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS);
        await this.cache.expire(skipsKey, VIDEO_ROOM_SEAT_QUEUE_TTL_SECONDS);
        // Auto-advance's audit + realtime-resolution counterpart to the manual
        // path's `driveSeating`: without these, an auto-promoted viewer's
        // client never learns their request resolved, and every promotion
        // metric (derived from REQUEST_RESOLVED) undercounts auto-advance rooms.
        await this.events.appendEvent({
          roomId,
          actorId,
          eventType: 'seat.queue_advanced',
          payload: { requestId: request.id, userId, seatIndex },
        });
        await this.bus.publish(
          new SeatRequestResolvedEvent({
            roomId,
            requestId: request.id,
            userId,
            status: 'PROMOTED',
            actorId,
            version: view.version,
            seatIndex,
            requestedAt: request.createdAt.toISOString(),
          }),
        );
        return userId;
      }

      return null;
    });

    await this.broadcastUpdate(roomId);
    return seated ?? null;
  }

  // ---- Internal ----

  /**
   * Read the current queue shape and publish it, without checking the
   * projection first. Callers that have already established the projection
   * (`enqueue`, `dequeue`) use this directly to avoid rebuilding twice.
   */
  private async broadcastUpdate(roomId: string): Promise<void> {
    const [size, rows] = await Promise.all([
      this.cache.sortedCount(videoRoomSeatQueueKey(roomId)),
      this.cache.sortedLowest(videoRoomSeatQueueKey(roomId), VIDEO_ROOM_QUEUE_PREVIEW_LIMIT),
    ]);
    const top: QueuePreviewEntry[] = await Promise.all(
      rows.slice(0, VIDEO_ROOM_QUEUE_PREVIEW_LIMIT).map(async (row, index) => ({
        userId: row.member,
        position: index + 1,
        vipLevel: await this.vipLevel(row.member),
      })),
    );
    try {
      await this.bus.publish(new SeatQueueUpdatedEvent({ roomId, size, top }));
    } catch (err) {
      this.logger.warn(
        `Seat queue update publish failed for room ${roomId}: ${(err as Error).message}`,
      );
    }
  }

  /** Rebuild the projection if Redis has lost it. */
  private async ensureProjection(roomId: string): Promise<void> {
    if (await this.cache.exists(videoRoomSeatQueueKey(roomId))) return;
    await this.rebuild(roomId);
  }

  /** 1-based position straight from Redis, without a projection check. */
  private async rawPosition(roomId: string, userId: string): Promise<number | null> {
    const rank = await this.cache.sortedRank(videoRoomSeatQueueKey(roomId), userId);
    return rank === null ? null : rank + 1;
  }

  /** Current score for a user, folding in VIP tier and accumulated skips. */
  private async scoreFor(roomId: string, userId: string, createdAt: Date): Promise<number> {
    const [vipLevel, skipCount] = await Promise.all([
      this.vipLevel(userId),
      this.skipCount(roomId, userId),
    ]);
    return computeQueueScore({ vipLevel, createdAt, skipCount });
  }

  /** Recompute and rewrite a queued user's score (after a skip changes it). */
  private async reScore(roomId: string, userId: string, createdAt: Date): Promise<void> {
    await this.cache.setScore(
      videoRoomSeatQueueKey(roomId),
      userId,
      await this.scoreFor(roomId, userId, createdAt),
    );
  }

  /** Wealth Level ordinal, degrading to 0 if the wealth module is unavailable. */
  private async vipLevel(userId: string): Promise<number> {
    try {
      return await this.wealth.getEffectiveLevel(userId);
    } catch (err) {
      this.logger.warn(
        `Wealth Level lookup failed for ${userId}; treating as level 0: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  private async skipCount(roomId: string, userId: string): Promise<number> {
    return (await this.cache.score(videoRoomSeatQueueSkipsKey(roomId), userId)) ?? 0;
  }
}
