import type { ConfigService } from '@nestjs/config';
import { toBool } from './video-room-gift.config';

/**
 * Typed view of the `videoRoomRanking` namespace.
 *
 * Weights are config rather than constants because they are the product
 * decision most likely to be retuned after launch — and because the SAME values
 * must drive both the incremental write path and the recompute pass. A weight
 * that lived in two places would let the two paths silently disagree, which is
 * exactly the drift the recompute exists to eliminate.
 *
 * `toBool` is reused for the same reason VR-10/11 do: the repo-wide
 * `z.coerce.boolean()` idiom turns the STRING "false" into `true`.
 */
export interface HostWeights {
  coins: number;
  gifts: number;
  watchSeconds: number;
  peakViewers: number;
  pkWin: number;
  treasureEvent: number;
}

export interface RoomWeights {
  giftCoins: number;
  peakViewers: number;
  avgWatchSeconds: number;
  pkCount: number;
  treasureCount: number;
}

export interface PkWeights {
  win: number;
  loss: number;
  score: number;
  giftCoins: number;
}

export interface VideoRoomRankingConfig {
  /** Master switch. When false the write path no-ops and reads serve snapshots. */
  enabled: boolean;
  /** TTL on a hydrated leaderboard page. */
  cacheTtlSeconds: number;
  /** How long a source event's dedupe marker survives. */
  dedupeTtlSeconds: number;
  /** TTL refreshed on every write to a room-scoped ladder, so dead rooms evict. */
  roomLadderTtlSeconds: number;
  /** TTL on a derived (quarterly/yearly) ladder. */
  derivedLadderTtlSeconds: number;
  /** Socket broadcast coalescing window per room. */
  coalesceWindowMs: number;
  /** Entries broadcast in a coalesced ranking update. */
  broadcastTopN: number;
  weights: { host: HostWeights; rooms: RoomWeights; pk: PkWeights };
  /** Snapshot retention. 0 means "never prune". */
  retentionDays: { hourly: number; daily: number; weekly: number };
  /** Ceiling on a custom range, in days. */
  maxCustomRangeDays: number;
}

interface RawConfig {
  enabled?: boolean | string;
  cacheTtlSeconds?: number | string;
  dedupeTtlSeconds?: number | string;
  roomLadderTtlSeconds?: number | string;
  derivedLadderTtlSeconds?: number | string;
  coalesceWindowMs?: number | string;
  broadcastTopN?: number | string;
  hostCoinWeight?: number | string;
  hostGiftWeight?: number | string;
  hostWatchSecondWeight?: number | string;
  hostPeakViewerWeight?: number | string;
  hostPkWinWeight?: number | string;
  hostTreasureEventWeight?: number | string;
  roomGiftCoinWeight?: number | string;
  roomPeakViewerWeight?: number | string;
  roomAvgWatchSecondWeight?: number | string;
  roomPkCountWeight?: number | string;
  roomTreasureCountWeight?: number | string;
  pkWinWeight?: number | string;
  pkLossWeight?: number | string;
  pkScoreWeight?: number | string;
  pkGiftCoinWeight?: number | string;
  retentionHourlyDays?: number | string;
  retentionDailyDays?: number | string;
  retentionWeeklyDays?: number | string;
  maxCustomRangeDays?: number | string;
}

/**
 * Coerce with a fallback. `Number('')` is 0 and `Number('abc')` is NaN — a 0
 * weight silently removes a signal from the composite and a NaN poisons every
 * score in the ladder, so anything non-finite falls back to the default.
 */
function num(value: number | string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadVideoRoomRankingConfig(config: ConfigService): VideoRoomRankingConfig {
  const raw = config.get<RawConfig>('videoRoomRanking');
  if (!raw) {
    throw new Error('videoRoomRanking config namespace is not registered');
  }
  return {
    enabled: toBool(raw.enabled, true),
    cacheTtlSeconds: num(raw.cacheTtlSeconds, 15),
    dedupeTtlSeconds: num(raw.dedupeTtlSeconds, 172_800), // 48h
    roomLadderTtlSeconds: num(raw.roomLadderTtlSeconds, 604_800), // 7d
    derivedLadderTtlSeconds: num(raw.derivedLadderTtlSeconds, 86_400),
    coalesceWindowMs: num(raw.coalesceWindowMs, 1_000),
    broadcastTopN: num(raw.broadcastTopN, 10),
    weights: {
      host: {
        coins: num(raw.hostCoinWeight, 1),
        gifts: num(raw.hostGiftWeight, 5),
        watchSeconds: num(raw.hostWatchSecondWeight, 0.01),
        peakViewers: num(raw.hostPeakViewerWeight, 2),
        pkWin: num(raw.hostPkWinWeight, 500),
        treasureEvent: num(raw.hostTreasureEventWeight, 50),
      },
      rooms: {
        giftCoins: num(raw.roomGiftCoinWeight, 1),
        peakViewers: num(raw.roomPeakViewerWeight, 10),
        avgWatchSeconds: num(raw.roomAvgWatchSecondWeight, 0.05),
        pkCount: num(raw.roomPkCountWeight, 100),
        treasureCount: num(raw.roomTreasureCountWeight, 25),
      },
      pk: {
        win: num(raw.pkWinWeight, 1000),
        loss: num(raw.pkLossWeight, 0),
        score: num(raw.pkScoreWeight, 1),
        giftCoins: num(raw.pkGiftCoinWeight, 0.5),
      },
    },
    retentionDays: {
      hourly: num(raw.retentionHourlyDays, 90),
      daily: num(raw.retentionDailyDays, 400),
      weekly: num(raw.retentionWeeklyDays, 400),
    },
    maxCustomRangeDays: num(raw.maxCustomRangeDays, 366),
  };
}
