import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TreasureBox, TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { DomainEvent } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { REDIS_CLIENT, type RedisClient } from 'src/infra/redis/redis.constants';
import { loadVideoRoomTreasureConfig } from '../config/video-room-treasure.config';
import {
  treasureActivityKey,
  treasureEmitKey,
  treasureLevelKey,
  treasureProgressKey,
  treasureStatsKey,
  treasureStatusKey,
} from '../constants/video-room-treasure.constants';
import { TreasureProgressUpdatedEvent } from '../events/video-room-treasure.events';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';

export interface TreasureContributionResult {
  sessionId: string | null;
  applied: number;
  events: DomainEvent<unknown>[];
  /** Lowest crossed box. Only this one is enqueued; the unlock chains the rest. */
  claimedBoxId: string | null;
  claimedLevel: number | null;
  correlationId: string;
  /** Level/progress of the box that ended up current, for the Redis mirror. */
  mirror: { level: number; progress: number } | null;
}

/** Bounded CAS retries. Losing three times in one gift means extreme contention. */
const MAX_CAS_RETRIES = 3;

/** Activity hash lifetime, refreshed on write. Long enough for a full session. */
const TREASURE_ACTIVITY_TTL_SECONDS = 6 * 60 * 60;

/**
 * TTL on the cached status view. Short enough that a progress bar is never
 * visibly stale, and the unlock pipeline invalidates explicitly so a payout is
 * never hidden behind a cache.
 */
const TREASURE_STATUS_TTL_SECONDS = 2;

/**
 * Raises the treasure counter from inside the gift transaction (VR-11 §6.2–6.3).
 *
 * Postgres-only by contract: no Redis, no queue, no sockets here. The Redis
 * mirror and the enqueue happen after commit, driven by what this returns —
 * which is why a treasure failure can never roll back a paid gift.
 *
 * Progress is a COUNTER, not an escrow: nothing here debits or credits anyone,
 * so overflow past the last box simply stops counting rather than refunding.
 */
@Injectable()
export class VideoRoomTreasureProgressService {
  private readonly logger = new Logger(VideoRoomTreasureProgressService.name);

  constructor(
    private readonly repo: VideoRoomTreasureRepository,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  /**
   * `countsTowardRanking` (default true) separates filling the ladder from
   * ranking for it. Progress always advances — coins are coins — but the
   * contribution rows are the ledger the winner draws read, so a gift that must
   * not buy its sender a place in that draw passes `false`. Self-gifts use this:
   * they fill the ladder without handing a solo host an uncontested podium.
   */
  async apply(
    tx: Prisma.TransactionClient,
    input: {
      roomId: string;
      senderId: string;
      amount: number;
      giftTxnId: string;
      batchId?: string;
      countsTowardRanking?: boolean;
    },
  ): Promise<TreasureContributionResult> {
    const correlationId = randomUUID();
    const idle: TreasureContributionResult = {
      sessionId: null,
      applied: 0,
      events: [],
      claimedBoxId: null,
      claimedLevel: null,
      correlationId,
      mirror: null,
    };

    if (input.amount <= 0) return idle;

    const session = await this.repo.findCurrentSession(input.roomId, tx);
    // Only an ACTIVE ladder accumulates. DRAFT, PAUSED and every terminal state
    // are silent no-ops: the gift still succeeds, it just does not count.
    if (!session || session.status !== TreasureSessionStatus.ACTIVE) return idle;

    const boxes = await this.repo.listBoxes(session.id, tx);
    const events: DomainEvent<unknown>[] = [];
    let remaining = BigInt(input.amount);
    let applied = 0n;
    let claimedBoxId: string | null = null;
    let claimedLevel: number | null = null;
    let mirror: { level: number; progress: number } | null = null;
    let level = session.currentLevel;

    while (remaining > 0n) {
      const box = boxes.find((b) => b.level === level);
      if (!box) break; // ladder exhausted — stop counting, refund nothing
      if (box.status === TreasureBoxStatus.OPENED || box.status === TreasureBoxStatus.UNLOCKING) {
        level += 1;
        continue;
      }

      const outcome = await this.applyToBox(tx, box, remaining);
      if (!outcome) break; // contention beyond retries; the next gift carries it

      // `delta` comes from the CAS that actually succeeded, NOT from
      // (updated.progress - box.progress). Under contention the retry re-reads a
      // progress value another transaction advanced, so that subtraction would
      // credit this gift with someone else's coins — inflating `applied` and,
      // worse, writing an inflated contribution row that skews the weighted and
      // contribution-based winner draws.
      const { box: updated, delta } = outcome;
      remaining -= delta;
      applied += delta;
      mirror = { level: updated.level, progress: Number(updated.progress) };

      if (input.countsTowardRanking !== false) {
        await this.repo.addContribution(
          {
            boxId: box.id,
            sessionId: session.id,
            roomId: input.roomId,
            userId: input.senderId,
            amount: delta,
            giftTxnId: input.giftTxnId,
          },
          tx,
        );
      }

      events.push(
        new TreasureProgressUpdatedEvent({
          correlationId,
          roomId: input.roomId,
          sessionId: session.id,
          boxId: box.id,
          level: box.level,
          batchId: input.batchId,
          progress: Number(updated.progress),
          threshold: Number(updated.threshold),
          percent: this.percent(updated.progress, updated.threshold),
        }),
      );

      if (updated.progress < updated.threshold) break;

      // Threshold crossed. Exactly one transaction wins this claim, and only it
      // is responsible for enqueueing the unlock.
      const won = await this.repo.claimUnlock(box.id, tx);
      if (won && claimedBoxId === null) {
        claimedBoxId = box.id;
        claimedLevel = box.level;
      }

      level += 1;
      const next = boxes.find((b) => b.level === level);
      if (next) {
        await this.repo.setSessionLevel(session.id, level, tx);
        await this.repo.activateBox(next.id, tx);
        // Reflect the promotion locally so a further spill in this same gift
        // sees an ACTIVE box rather than the stale PENDING snapshot.
        next.status = TreasureBoxStatus.ACTIVE;
      }
    }

    return {
      sessionId: session.id,
      applied: Number(applied),
      events,
      claimedBoxId,
      claimedLevel,
      correlationId,
      mirror,
    };
  }

  /**
   * Compare-and-set with bounded retry. `addProgress` returns null when another
   * transaction moved progress first — normal under load, so we re-read and try
   * again rather than failing the gift.
   */
  private async applyToBox(
    tx: Prisma.TransactionClient,
    box: TreasureBox,
    remaining: bigint,
  ): Promise<{ box: TreasureBox; delta: bigint } | null> {
    let current = box;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const needed = current.threshold - current.progress;
      // Already full — nothing to add, but the caller still needs to claim it.
      if (needed <= 0n) return { box: current, delta: 0n };
      const delta = remaining < needed ? remaining : needed;

      const updated = await this.repo.addProgress(current.id, current.progress, delta, tx);
      if (updated) return { box: updated, delta };

      const fresh = await this.repo.getBox(current.id, tx);
      if (!fresh) return null;
      current = fresh;
    }
    this.logger.warn(`CAS contention exhausted on treasure box ${box.id}`);
    return null;
  }

  private percent(progress: bigint, threshold: bigint): number {
    if (threshold <= 0n) return 0;
    const capped = progress > threshold ? threshold : progress;
    return Number((capped * 10_000n) / threshold) / 100;
  }

  /**
   * Mirrors committed progress into Redis. Post-commit only.
   *
   * Writing the current level/progress also INVALIDATES the cached status view:
   * the ladder just moved, so the cached snapshot is stale by definition. That
   * is what keeps the 2-second status cache from ever showing a progress bar
   * that has already advanced.
   */
  async mirror(roomId: string, level: number, progress: number): Promise<void> {
    await Promise.all([
      this.cache.set(treasureProgressKey(roomId), { level, progress }),
      this.cache.set(treasureLevelKey(roomId), level),
      this.cache.del(treasureStatusKey(roomId)),
    ]);
  }

  /** Read the cached status view, or null on a miss. */
  readStatusCache<T>(roomId: string): Promise<T | null> {
    return this.cache.get<T>(treasureStatusKey(roomId));
  }

  /** Cache a computed status view behind a short TTL. */
  async writeStatusCache(roomId: string, view: unknown): Promise<void> {
    await this.cache.set(treasureStatusKey(roomId), view, TREASURE_STATUS_TTL_SECONDS);
  }

  /**
   * Drop the cached status view outright. Called when a box opens so a payout
   * is never hidden behind a stale snapshot, and on every lifecycle transition.
   */
  async invalidateStatus(roomId: string): Promise<void> {
    await this.cache.del(treasureStatusKey(roomId));
  }

  /**
   * Live per-session counters (VR-11 "Temporary Statistics"). A HASH of running
   * totals so an operator or an in-room panel can read a session's shape without
   * aggregating the ledger — Postgres stays the system of record, this is the
   * cheap read. Expires with the session rather than accumulating forever.
   */
  async recordUnlockStats(
    roomId: string,
    sessionId: string,
    stats: { minted: number; winners: number },
  ): Promise<void> {
    const key = treasureStatsKey(roomId, sessionId);
    await this.redis.hincrby(key, 'boxesOpened', 1);
    await this.redis.hincrby(key, 'totalMinted', stats.minted);
    await this.redis.hincrby(key, 'totalWinners', stats.winners);
    await this.redis.expire(key, TREASURE_ACTIVITY_TTL_SECONDS);
  }

  /** Read the live session counters. Returns zeros when nothing has unlocked. */
  async readStats(
    roomId: string,
    sessionId: string,
  ): Promise<{ boxesOpened: number; totalMinted: number; totalWinners: number }> {
    const raw = await this.redis.hgetall(treasureStatsKey(roomId, sessionId));
    return {
      boxesOpened: Number(raw?.boxesOpened ?? 0) || 0,
      totalMinted: Number(raw?.totalMinted ?? 0) || 0,
      totalWinners: Number(raw?.totalWinners ?? 0) || 0,
    };
  }

  /**
   * Feeds the ACTIVITY_BASED algorithm and the min-activity eligibility floor.
   *
   * Written as a HASH field (`HINCRBY key userId 1`), NOT as a per-user STRING,
   * because the eligibility service reads the whole cohort in one `HMGET`. An
   * earlier revision incremented `…:{sessionId}:{userId}` as a string while the
   * reader did `HMGET …:{sessionId}` — different keys AND different types, so
   * every count read as 0. That silently degraded ACTIVITY_BASED to a uniform
   * draw and, worse, made any `minActivityEvents > 0` exclude the entire room.
   *
   * The TTL is refreshed on each write so the hash outlives a long session but
   * cannot leak once the room goes quiet.
   */
  async recordActivity(roomId: string, sessionId: string, userId: string): Promise<void> {
    const key = treasureActivityKey(roomId, sessionId);
    await this.redis.hincrby(key, userId, 1);
    await this.redis.expire(key, TREASURE_ACTIVITY_TTL_SECONDS);
  }

  /**
   * Throttle gate for `treasureProgressUpdated`. A hot room at 200 gifts/sec
   * would otherwise push 200 broadcasts/sec of a barely-changed number to every
   * connected socket. Threshold crossings bypass this entirely — the caller
   * simply does not consult it.
   */
  async shouldEmit(roomId: string): Promise<boolean> {
    const perSecond = loadVideoRoomTreasureConfig(this.config).progressEmitPerSecond;
    if (perSecond <= 0) return true;
    const key = treasureEmitKey(roomId);
    const last = await this.cache.get<number>(key);
    const now = Date.now();
    if (last !== null && now - last < Math.floor(1000 / perSecond)) return false;
    await this.cache.set(key, now, 60);
    return true;
  }
}
