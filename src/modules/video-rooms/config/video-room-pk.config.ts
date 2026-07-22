import type { ConfigService } from '@nestjs/config';
import { toBool } from './video-room-gift.config';

/**
 * Typed view of the `videoRoomPk` namespace.
 *
 * Namespaced config surfaces as raw process.env strings at runtime, so every
 * value is re-coerced here once (the VR-10 approach). Booleans bypass the zod
 * schema deliberately: `z.coerce.boolean()` turns the STRING "false" into `true`,
 * so an operator writing VIDEO_ROOM_PK_ENABLED=false would silently enable it.
 */
export interface VideoRoomPkConfig {
  /** Master switch. When false, every lifecycle command is refused. */
  enabled: boolean;
  /** Pre-battle countdown before the clock starts. */
  countdownSeconds: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  defaultDurationSeconds: number;
  /** How long an invitation stays actionable. */
  invitationTtlSeconds: number;
  /** Share of BASE contribution minted as the reward pool (1000 = 10%). */
  poolBps: number;
  /** Split of the pool. winner + participation + bonus must be ≤ 10000. */
  winnerBps: number;
  participationBps: number;
  bonusBps: number;
  /** Ceiling on the composed score multiplier. 30000 = 3.0×. */
  multiplierCapBps: number;
  /** Bonus bps added per VIP tier level. */
  vipBonusBpsPerTier: number;
  eventBonusBps: number;
  eventMultiplierEnabled: boolean;
  /** Ceiling on `pkScoreUpdated` broadcasts per battle per second. */
  scoreEmitPerSecond: number;
  recoveryEnabled: boolean;
  monitorIntervalSeconds: number;
  /** A RECOVERING battle older than this is settled with current scores. */
  orphanTimeoutSeconds: number;
  /** Grace given to a dropped host before the battle is settled. */
  recoveryGraceSeconds: number;
  maxPerSweep: number;
}

interface RawVideoRoomPkConfig {
  enabled?: boolean | string;
  countdownSeconds?: number | string;
  minDurationSeconds?: number | string;
  maxDurationSeconds?: number | string;
  defaultDurationSeconds?: number | string;
  invitationTtlSeconds?: number | string;
  poolBps?: number | string;
  winnerBps?: number | string;
  participationBps?: number | string;
  bonusBps?: number | string;
  multiplierCapBps?: number | string;
  vipBonusBpsPerTier?: number | string;
  eventBonusBps?: number | string;
  eventMultiplierEnabled?: boolean | string;
  scoreEmitPerSecond?: number | string;
  recoveryEnabled?: boolean | string;
  monitorIntervalSeconds?: number | string;
  orphanTimeoutSeconds?: number | string;
  recoveryGraceSeconds?: number | string;
  maxPerSweep?: number | string;
}

const num = (v: number | string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback;
};

export function loadVideoRoomPkConfig(config: ConfigService): VideoRoomPkConfig {
  const raw = config.get<RawVideoRoomPkConfig>('videoRoomPk') ?? {};
  return {
    enabled: toBool(raw.enabled, true),
    countdownSeconds: num(raw.countdownSeconds, 10),
    minDurationSeconds: num(raw.minDurationSeconds, 60),
    maxDurationSeconds: num(raw.maxDurationSeconds, 1800),
    defaultDurationSeconds: num(raw.defaultDurationSeconds, 300),
    invitationTtlSeconds: num(raw.invitationTtlSeconds, 60),
    poolBps: num(raw.poolBps, 1000),
    winnerBps: num(raw.winnerBps, 6000),
    participationBps: num(raw.participationBps, 3000),
    bonusBps: num(raw.bonusBps, 1000),
    multiplierCapBps: num(raw.multiplierCapBps, 30_000),
    vipBonusBpsPerTier: num(raw.vipBonusBpsPerTier, 500),
    eventBonusBps: num(raw.eventBonusBps, 0),
    eventMultiplierEnabled: toBool(raw.eventMultiplierEnabled, false),
    scoreEmitPerSecond: num(raw.scoreEmitPerSecond, 10),
    recoveryEnabled: toBool(raw.recoveryEnabled, false),
    monitorIntervalSeconds: num(raw.monitorIntervalSeconds, 15),
    orphanTimeoutSeconds: num(raw.orphanTimeoutSeconds, 120),
    recoveryGraceSeconds: num(raw.recoveryGraceSeconds, 45),
    maxPerSweep: num(raw.maxPerSweep, 50),
  };
}
