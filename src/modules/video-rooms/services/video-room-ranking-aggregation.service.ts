import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  LeaderboardStore,
  type RankedEntry,
  RankingPeriodResolver,
  type RankingPeriodName,
} from 'src/modules/rankings/interfaces';
import {
  loadVideoRoomRankingConfig,
  type VideoRoomRankingConfig,
} from '../config/video-room-ranking.config';
import {
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_DERIVED_PERIODS,
  VIDEO_ROOM_RANKING_NAMESPACE,
  errorMessage,
  scopeCity,
  scopeCountry,
  scopeGlobal,
} from '../constants/video-room-ranking.constants';
import {
  AggregationException,
  RankingPeriodException,
} from '../exceptions/video-room-ranking.exceptions';
import { RankingAggregatedEvent } from '../events/video-room-ranking.events';
import type {
  AggregationWindow,
  RankingLadderKey,
} from '../repositories/video-room-ranking.repository';
import { VideoRoomRankingRepository } from '../repositories/video-room-ranking.repository';
import { VideoRoomRankingScopeResolver } from './video-room-ranking-scope.resolver';
import { VideoRoomRankingScoreEngine } from './video-room-ranking-score.engine';

export interface AggregationResult {
  key: RankingLadderKey;
  status: 'RECOMPUTED' | 'SKIPPED' | 'FAILED';
  entriesWritten: number;
  sourceRows: number;
  durationMs: number;
}

/** One entity's recomputed standing, before scope partitioning. */
interface SourceRow {
  member: string;
  score: number;
  /**
   * Absent when a source aggregate has no attributable user. No dimension
   * this service still recomputes leaves this undefined today — `rooms`,
   * which did, is now excluded from recompute entirely (see
   * `RECOMPUTE_EXCLUDED_DIMENSIONS`) — but the field stays optional in case a
   * future recomputable dimension needs the same room-shaped case.
   */
  userId?: string;
}

/**
 * Dimensions this service refuses to recompute, and exactly why each one
 * cannot currently be reproduced from the source tables. This is a PRODUCT
 * decision, not a temporary gap: rather than change the schema to make these
 * two reproducible, the product owner chose to exclude them from the batch
 * job and leave them live-path-only. `hosts` and `rooms` are not broken —
 * the incremental write path (`video-room-ranking.service.ts`) keeps
 * maintaining both ladders exactly as it always has. This constant only stops
 * the RECOMPUTE from clobbering them with a wrong recount.
 *
 * - `hosts` — the write path only credits a receiver who HOLDS A SEAT at the
 *   moment the gift lands (`if (input.receiverIsSeated)` in
 *   `video-room-ranking.service.ts`). `gift_transactions` — the only table a
 *   recompute can read for this — persists no seat/role status alongside the
 *   transaction, so `aggregateGiftCoinsByReceiver` cannot distinguish a
 *   seated host from a spectator being tipped: it would credit EVERY
 *   receiver, seated or not. That is a different population than the live
 *   ladder ranks, not a noisier version of the same one. To enable this
 *   later: the gift (or a companion row) would need to persist whether the
 *   receiver was seated at delivery time, so a recompute could filter on it
 *   the same way the live path branches on `receiverIsSeated`.
 *
 * - `rooms` — the recompute would pull `peakViewers` / `avgWatchTimeSeconds`
 *   / `totalPkCount` from `repo.findRoomStatistics`, which reads
 *   `VideoRoomStatistics` — documented in `prisma/schema/video_rooms.prisma`
 *   as "Rolling lifetime aggregates", with NO window scoping (it is the only
 *   repository aggregate consumed here that takes no `window` parameter at
 *   all). Every window's `rooms` score would be dominated by an
 *   ever-growing lifetime constant instead of that window's activity — a
 *   daily ladder would move by roughly the same amount a yearly one would.
 *   To enable this later: those three counters would need a per-window (or
 *   at minimum per-day) rollup table alongside the lifetime one, so a
 *   recompute could read "peak viewers IN THIS WINDOW" rather than "peak
 *   viewers ever".
 *
 * Dead-code pointer: the removed `HOSTS` / `ROOMS` cases in `loadSourceRows`
 * used to read `aggregateGiftCoinsByReceiver` (hosts — crediting every
 * receiver) and `aggregateGiftCoinsByRoom` + `findRoomStatistics` (rooms —
 * the gift-coin term plus the three lifetime counters above). See git
 * history on this file for their exact shape if either gap above ever gets
 * closed. Do NOT re-add either case without first fixing what it describes —
 * that is precisely the "fix" this constant exists to block.
 *
 * Exported so `VideoRoomRankingRecoveryService.replay` can skip invalidating
 * the aggregation-log guard for dimensions `recomputeAll` will never touch —
 * that source of truth belongs here, next to the code it governs, not
 * duplicated as a second list a future edit could let drift out of sync.
 */
export const RECOMPUTE_EXCLUDED_DIMENSIONS: ReadonlySet<VideoRoomRankingDimension> = new Set([
  VideoRoomRankingDimension.HOSTS,
  VideoRoomRankingDimension.ROOMS,
]);

/** Terse, log-line-sized reason for each excluded dimension — see the block comment above for the full explanation. */
const RECOMPUTE_EXCLUSION_REASON: Record<
  VideoRoomRankingDimension.HOSTS | VideoRoomRankingDimension.ROOMS,
  string
> = {
  [VideoRoomRankingDimension.HOSTS]:
    'gift_transactions has no seat/role column, so a recompute cannot tell a seated host from a tipped spectator',
  [VideoRoomRankingDimension.ROOMS]:
    'VideoRoomStatistics is a rolling lifetime aggregate with no window scoping',
};

/** Dimensions `loadSourceRows` may still be asked to load. */
type RecomputableDimension = Exclude<
  VideoRoomRankingDimension,
  VideoRoomRankingDimension.HOSTS | VideoRoomRankingDimension.ROOMS
>;

function isRecomputeExcluded(
  dimension: VideoRoomRankingDimension,
): dimension is VideoRoomRankingDimension.HOSTS | VideoRoomRankingDimension.ROOMS {
  return RECOMPUTE_EXCLUDED_DIMENSIONS.has(dimension);
}

/**
 * The authoritative half of the lambda model.
 *
 * Where the write path ACCUMULATES deltas, this RECOUNTS a closed window from
 * the source tables and swaps the result in. That is what makes the whole
 * design tolerant of the write path's known gaps — a crash between the dedupe
 * marker and the fan-out, an evicted marker, a Redis flush, a listener that was
 * down during a deploy. None of them survive the next run of this service.
 *
 * The correctness hinge is that it scores through the SAME
 * VideoRoomRankingScoreEngine the write path uses. A second implementation of
 * the weighting here would reintroduce exactly the drift this exists to remove.
 * That hinge only holds where a recompute CAN reproduce the write path's
 * population and inputs exactly. `hosts` and `rooms` cannot — see
 * `RECOMPUTE_EXCLUDED_DIMENSIONS` below — and this service refuses to touch
 * either ladder at all; they remain live-path-only.
 *
 * Geography, like the write path, is resolved PER DIMENSION rather than per
 * event — but here there IS no event, only whichever `userId` each source
 * aggregate query already attributes the row to. Of the dimensions this
 * service still recomputes:
 *   - `gifters`         → `aggregateGiftCoinsBySender` returns the SENDER as
 *                          `userId`, so partitioning on it is the sender's
 *                          geography, matching the write path.
 *   - `receivers`       → `aggregateGiftCoinsByReceiver` returns the RECEIVER
 *                          as `userId`.
 *   - `pk` / `treasure` → each row's own `userId` is the scored user.
 * (`hosts` would have shared `receivers`' query and geography rule, and
 * `rooms` has no `userId` column at all — see `RECOMPUTE_EXCLUDED_DIMENSIONS`.
 * Neither case is reachable here anymore.)
 * Because every remaining query already returns the correct attributable id
 * for its dimension, resolving geography from that same `userId` reproduces
 * the write path's attribution without this file needing a per-dimension
 * switch of its own for it.
 */
@Injectable()
export class VideoRoomRankingAggregationService {
  private readonly logger = new Logger(VideoRoomRankingAggregationService.name);
  private readonly config: VideoRoomRankingConfig;
  private readonly ns = VIDEO_ROOM_RANKING_NAMESPACE;

  constructor(
    config: ConfigService,
    private readonly repo: VideoRoomRankingRepository,
    private readonly store: LeaderboardStore,
    private readonly periods: RankingPeriodResolver,
    private readonly scoring: VideoRoomRankingScoreEngine,
    private readonly scopes: VideoRoomRankingScopeResolver,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {
    this.config = loadVideoRoomRankingConfig(config);
  }

  /**
   * Recompute every dimension for one window. One dimension's failure must not
   * abandon the rest of the window — each is caught independently and reported
   * as a FAILED result rather than throwing out of the loop. The individual
   * `recomputeDimension` call has already recorded the failure via
   * `failAggregation` and rethrown for its own retry/dead-letter handling; this
   * loop's catch exists purely so the OTHER dimensions still get their chance.
   */
  async recomputeAll(period: RankingPeriodName, dateKey: string): Promise<AggregationResult[]> {
    const results: AggregationResult[] = [];
    for (const dimension of Object.values(VideoRoomRankingDimension)) {
      try {
        results.push(await this.recomputeDimension(dimension, period, dateKey));
      } catch (err) {
        this.logger.error(
          `recompute ${dimension}:${period}:${dateKey} failed: ${errorMessage(err)}`,
        );
        results.push({
          key: { scope: scopeGlobal(), dimension, period, dateKey },
          status: 'FAILED',
          entriesWritten: 0,
          sourceRows: 0,
          durationMs: 0,
        });
      }
    }
    return results;
  }

  async recomputeDimension(
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    dateKey: string,
  ): Promise<AggregationResult> {
    // Refuse outright rather than silently no-op: see
    // `RECOMPUTE_EXCLUDED_DIMENSIONS` for why `hosts`/`rooms` can never be
    // reproduced from source data. No repo call, no store call, no
    // aggregation-log row — nothing here may run for these two. This guard
    // is what makes `recomputeAll`'s skip visible and safe too, since its
    // loop calls this method once per dimension every run.
    if (isRecomputeExcluded(dimension)) {
      this.logger.warn(
        `${dimension}:${period}:${dateKey} skipped — excluded from recompute (${RECOMPUTE_EXCLUSION_REASON[dimension]}); the live incremental path remains authoritative for it`,
      );
      return {
        key: { scope: scopeGlobal(), dimension, period, dateKey },
        status: 'SKIPPED',
        entriesWritten: 0,
        sourceRows: 0,
        durationMs: 0,
      };
    }

    if (!this.periods.isValidDateKey(period, dateKey)) {
      throw new RankingPeriodException(`"${dateKey}" is not a valid ${period} date key`);
    }

    const key: RankingLadderKey = { scope: scopeGlobal(), dimension, period, dateKey };
    const window = this.periods.windowFor(period, dateKey);
    const startedAt = Date.now();

    const claim = await this.repo.beginAggregation(key, window.start, window.end);
    if (claim === 'ALREADY_SUCCEEDED') {
      this.logger.debug(`${dimension}:${period}:${dateKey} already aggregated — skipping`);
      return { key, status: 'SKIPPED', entriesWritten: 0, sourceRows: 0, durationMs: 0 };
    }

    try {
      const rows = await this.loadSourceRows(dimension, window);
      const written = await this.writeScopedLadders(dimension, period, dateKey, rows);
      const durationMs = Date.now() - startedAt;

      await this.repo.completeAggregation(key, {
        sourceRows: rows.length,
        entriesWritten: written,
        durationMs,
      });

      await this.bus.publish(
        new RankingAggregatedEvent({
          scope: key.scope,
          dimension,
          period,
          dateKey,
          entriesWritten: written,
          sourceRows: rows.length,
          durationMs,
        }),
      );

      return {
        key,
        status: 'RECOMPUTED',
        entriesWritten: written,
        sourceRows: rows.length,
        durationMs,
      };
    } catch (err) {
      await this.repo.failAggregation(key, errorMessage(err));
      // Rethrown on purpose: this is a genuine failure, and BullMQ's retry then
      // dead-letter path is the correct handling. Swallowing would leave a
      // silently wrong ladder with a FAILED log row nobody reads.
      throw err;
    }
  }

  /**
   * Recount a window from the source tables, scored through the shared
   * engine. `dimension` is typed `RecomputableDimension`, not the full enum —
   * `HOSTS` and `ROOMS` are refused by `recomputeDimension` before this is
   * ever called (see `RECOMPUTE_EXCLUDED_DIMENSIONS`), so the compiler
   * enforces that this switch never needs to handle either. Do not widen the
   * parameter type back to `VideoRoomRankingDimension` to "add them back" —
   * that is precisely the mistake `RECOMPUTE_EXCLUDED_DIMENSIONS` exists to
   * prevent.
   */
  private async loadSourceRows(
    dimension: RecomputableDimension,
    window: AggregationWindow,
  ): Promise<SourceRow[]> {
    switch (dimension) {
      case VideoRoomRankingDimension.GIFTERS: {
        const rows = await this.repo.aggregateGiftCoinsBySender(window);
        return rows.map((r) => ({
          member: r.userId,
          userId: r.userId,
          score: this.scoring.composite(dimension, { coinsSpent: Number(r.coins) }),
        }));
      }
      case VideoRoomRankingDimension.RECEIVERS: {
        const rows = await this.repo.aggregateGiftCoinsByReceiver(window);
        return rows.map((r) => ({
          member: r.userId,
          userId: r.userId,
          score: this.scoring.composite(dimension, { coinsReceived: Number(r.coins) }),
        }));
      }
      case VideoRoomRankingDimension.PK: {
        const rows = await this.repo.aggregatePkOutcomes(window);
        return rows.map((r) => ({
          member: r.userId,
          userId: r.userId,
          // `weights.pk.giftCoins` is deliberately NOT passed here, even
          // though `aggregatePkOutcomes` returns a `giftCoins` field. The
          // live path's `recordPkResult` scores PK deltas from
          // `PkRankingInput['outcomes']`, whose shape is only
          // `{userId, won, lost, score}` — it never carries a coin figure at
          // all, so `deltaFor(PK, ...)` on the write path never includes a
          // giftCoins term. If this composite included one, every recompute
          // would step the PK ladder by `giftCoins * weights.pk.giftCoins`
          // that the live path never added, and the "same number both paths
          // produce" invariant this whole service exists for would break on
          // literally every run. Re-enable this ONLY once BOTH paths can
          // supply the value — i.e. once `PkRankingInput['outcomes']` also
          // carries a coin figure and `recordPkResult` passes it through.
          // Adding it back here alone reintroduces exactly this drift.
          score: this.scoring.composite(dimension, {
            wins: r.wins,
            losses: r.losses,
            score: Number(r.score),
          }),
        }));
      }
      case VideoRoomRankingDimension.TREASURE: {
        const rows = await this.repo.aggregateTreasureWinnings(window);
        return rows.map((r) => ({
          member: r.userId,
          userId: r.userId,
          score: this.scoring.composite(dimension, { treasureCoins: Number(r.coins) }),
        }));
      }
      case VideoRoomRankingDimension.VIP:
        // VIP standing is a property of the account, not of a time window —
        // there is nothing in gift/PK/treasure history to recount it from. It
        // is maintained solely by the incremental path.
        return [];
    }
  }

  /**
   * Partition the recomputed rows into global, country and city ladders and
   * swap each in. Geography is re-resolved here rather than trusted from write
   * time, which is what lets a country ladder heal even if the cached geo was
   * wrong or missing when the original gift landed.
   *
   * Returns the WIDTH of the recomputed ladder — the number of distinct
   * members this window produced — not the sum of entries across every scope
   * replica. A single gifter fans out into the global, country and city
   * ladders alike; that is one recomputed entry appearing three times, not
   * three entries. `entriesWritten` reports the former so it stays meaningful
   * against `sourceRows` (one row in, one ladder entry out) regardless of how
   * many scope ladders happen to receive a copy.
   *
   * KNOWN LIMITATION — an emptied country/city scope is never cleared. Only
   * scopes present in THIS run's `rows` are visited below (`byScope` is built
   * purely from what geography this window's rows resolve to); the global
   * scope is always visited because it is seeded unconditionally above. If a
   * country had entries in a previous run of this exact (dimension, period,
   * dateKey) and this window produces zero rows for it — every gifter from
   * that country churned out, or the window is simply quieter — that
   * country's key is never touched here, so `store.replace` never runs for
   * it and its stale ladder survives untouched. Country/city (and global)
   * ladders also carry no TTL from this write path (only room-scoped ladders
   * on the live path do, via `roomLadderTtlSeconds`), so nothing else expires
   * it either — it can persist indefinitely until a LATER run happens to
   * produce entries for that same scope again and overwrites it.
   *
   * Fixing this properly requires knowing, before writing, which scopes this
   * (dimension, period, dateKey) ladder had last time — and that is not
   * tracked anywhere today: `VideoRoomRankingAggregationLog` is keyed with
   * `scope` fixed to `scopeGlobal()` by `recomputeDimension` (it never
   * records the country/city scopes a run touched), `VideoRoomLeaderboardSnapshot`
   * is written by no code path yet (see the repository — `upsertLeaderboardSnapshot`
   * has no caller today), and `LeaderboardStore` exposes no SCAN/KEYS-style
   * primitive to enumerate existing `vrank:{c:*|dimension}:period:dateKey`
   * keys directly from Redis. Building any of those is real new machinery —
   * a schema change, a new write path, or a new store primitive — and is
   * deliberately NOT invented here to close this gap; it would expand this
   * fix well past the three findings it was scoped to. The retention/cleanup
   * job (`VIDEO_ROOM_RANKING_JOBS.CLEANUP`) is the intended place to solve
   * this properly, e.g. by TTL-ing country/city ladders the way room ladders
   * already are, or by sweeping Redis for ladder keys that were not
   * refreshed within N runs of their period and deleting them.
   */
  private async writeScopedLadders(
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    dateKey: string,
    rows: SourceRow[],
  ): Promise<number> {
    const ttl = this.config.derivedLadderTtlSeconds;
    const byScope = new Map<string, RankedEntry[]>();
    byScope.set(
      scopeGlobal(),
      rows.map((r) => ({ member: r.member, score: r.score })),
    );

    const userIds = rows.map((r) => r.userId).filter((id): id is string => Boolean(id));
    if (userIds.length > 0) {
      const geo = await this.scopes.geoForMany(userIds);
      for (const row of rows) {
        if (!row.userId) continue;
        const g = geo.get(row.userId);
        const entry: RankedEntry = { member: row.member, score: row.score };
        if (g?.country) {
          const s = scopeCountry(g.country);
          byScope.set(s, [...(byScope.get(s) ?? []), entry]);
        }
        if (g?.city) {
          const s = scopeCity(g.city);
          byScope.set(s, [...(byScope.get(s) ?? []), entry]);
        }
      }
    }

    for (const [scope, entries] of byScope) {
      await this.store.replace(
        this.store.key(this.ns, scope, dimension, period, dateKey),
        entries,
        ttl,
      );
      // Every cached page of this ladder is now stale.
      await this.store.bumpVersion(this.ns, scope, dimension);
    }
    return rows.length;
  }

  /**
   * Materialise a derived period by unioning its hot constituents. Quarterly and
   * yearly are never incremented, so this is the only way they come to exist.
   */
  async derivePeriod(
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    dateKey: string,
  ): Promise<number> {
    if (!VIDEO_ROOM_RANKING_DERIVED_PERIODS.includes(period)) {
      throw new AggregationException(
        `"${period}" is materialised on the write path and must not be derived`,
      );
    }
    const parts = this.periods.constituentsOf(period, dateKey);
    const dest = this.store.key(this.ns, scopeGlobal(), dimension, period, dateKey);
    const sources = parts.map((p) =>
      this.store.key(this.ns, scopeGlobal(), dimension, p.period, p.dateKey),
    );
    const count = await this.store.derive(dest, sources, this.config.derivedLadderTtlSeconds);
    await this.store.bumpVersion(this.ns, scopeGlobal(), dimension);
    return count;
  }
}
