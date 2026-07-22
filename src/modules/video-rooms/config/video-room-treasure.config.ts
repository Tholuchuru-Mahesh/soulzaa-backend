import type { ConfigService } from '@nestjs/config';
import { toBool } from './video-room-gift.config';

/**
 * Typed view of the `videoRoomTreasure` namespace.
 *
 * Namespaced config surfaces as raw process.env strings at runtime, so every
 * value is re-coerced here once — the VR-10 approach. `toBool` is reused rather
 * than re-derived: the repo-wide `z.coerce.boolean()` idiom turns the STRING
 * "false" into `true` (any non-empty string is truthy), so an operator writing
 * VIDEO_ROOM_TREASURE_RECOVERY_ENABLED=false would silently enable DLQ replay
 * in production. Booleans therefore bypass the zod schema and are read raw.
 */
export interface VideoRoomTreasureConfig {
  /** Master switch. When false, lifecycle commands are refused. */
  enabled: boolean;
  /** Default pool share in basis points (1000 = 10%). */
  poolBps: number;
  /** Default winners drawn per box. */
  winnerCount: number;
  /** Candidate oversample multiple of winnerCount. */
  oversampleFactor: number;
  /** Floor on the oversample, so small draws still sample widely. */
  oversampleMin: number;
  /** Seconds a user must have been in the room to be eligible. */
  minStaySeconds: number;
  /** Activity events required to be eligible. 0 makes the counter opt-in. */
  minActivityEvents: number;
  /** Ceiling on `treasureProgressUpdated` broadcasts per room per second. */
  progressEmitPerSecond: number;
  /** A box UNLOCKING longer than this with no pool row is re-enqueued. */
  orphanTimeoutSeconds: number;
  recoveryEnabled: boolean;
  monitorIntervalSeconds: number;
}

interface RawVideoRoomTreasureConfig {
  enabled?: boolean | string;
  poolBps?: number | string;
  winnerCount?: number | string;
  oversampleFactor?: number | string;
  oversampleMin?: number | string;
  minStaySeconds?: number | string;
  minActivityEvents?: number | string;
  progressEmitPerSecond?: number | string;
  orphanTimeoutSeconds?: number | string;
  recoveryEnabled?: boolean | string;
  monitorIntervalSeconds?: number | string;
}

/**
 * Coerce with a fallback. `Number('')` is 0 and `Number('abc')` is NaN — both
 * would silently disable a throttle or zero a pool, so anything non-finite
 * falls back to the documented default rather than propagating.
 */
function num(value: number | string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Read + coerce the `videoRoomTreasure` namespace. */
export function loadVideoRoomTreasureConfig(config: ConfigService): VideoRoomTreasureConfig {
  const raw = config.get<RawVideoRoomTreasureConfig>('videoRoomTreasure');
  if (!raw) {
    throw new Error('videoRoomTreasure config namespace is not registered');
  }
  return {
    enabled: toBool(raw.enabled, true),
    poolBps: num(raw.poolBps, 1000),
    winnerCount: num(raw.winnerCount, 3),
    oversampleFactor: num(raw.oversampleFactor, 3),
    oversampleMin: num(raw.oversampleMin, 50),
    minStaySeconds: num(raw.minStaySeconds, 120),
    minActivityEvents: num(raw.minActivityEvents, 0),
    progressEmitPerSecond: num(raw.progressEmitPerSecond, 5),
    orphanTimeoutSeconds: num(raw.orphanTimeoutSeconds, 120),
    recoveryEnabled: toBool(raw.recoveryEnabled, false),
    monitorIntervalSeconds: num(raw.monitorIntervalSeconds, 30),
  };
}
