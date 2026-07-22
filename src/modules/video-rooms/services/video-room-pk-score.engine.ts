import { Injectable, Logger } from '@nestjs/common';
import type { VideoRoomPkConfig } from '../config/video-room-pk.config';
import { PK_MULTIPLIER_BASE_BPS } from '../constants/video-room-pk.constants';
import type { Db } from '../repositories/video-room-pk.repository';

/**
 * Frozen scoring rules for ONE battle, captured by `snapshot()` when the
 * battle starts and carried on every gift leg via `PkScoreContext.snapshot`.
 *
 * "Frozen" is the point: `strategies` is the allow-list of strategy keys that
 * may contribute to THIS battle, decided once from config at start time. An
 * admin retuning `videoRoomPk.*` mid-battle — or registering a brand-new
 * strategy — cannot change the rules of a battle already in flight, because
 * `resolve()` only consults strategies named here, never the live config.
 */
export interface PkScoringSnapshot {
  strategies: string[];
  vipBonusBpsPerTier: number;
  eventBonusBps: number;
  capBps: number;
}

/** Everything one strategy needs to price one gift leg. */
export interface PkScoreContext {
  roomId: string;
  battleId: string;
  senderId: string;
  receiverId: string;
  baseAmount: number;
  snapshot: PkScoringSnapshot;
  /**
   * The gift's own transaction client. `resolve()` runs INSIDE the gift's
   * money transaction, so any strategy that reads the database must read
   * through this — never through a module-level PrismaService — or it would
   * see a snapshot of the database from outside the transaction.
   */
  db: Db;
}

/** One pluggable contributor to the composed score multiplier. */
export interface IPkScoreStrategy {
  readonly key: string;
  bonusBps(ctx: PkScoreContext): Promise<number> | number;
}

/**
 * The replaceable PK score engine (VR-12 Task 11).
 *
 * Strategies self-register on module init (the `GiftContextRegistry` /
 * `VideoRoomGiftContextHandler` pattern), and `resolve()` composes whichever
 * of them the battle's frozen snapshot names. See the doc comment on
 * `resolve()` for the four properties that make this safe to call from
 * inside a paid gift's money transaction.
 */
@Injectable()
export class VideoRoomPkScoreEngine {
  private readonly logger = new Logger(VideoRoomPkScoreEngine.name);
  private readonly strategies = new Map<string, IPkScoreStrategy>();

  /**
   * Register a strategy. Refuses a duplicate key rather than overwriting it:
   * silently keeping the last one registered would make scoring depend on
   * module load order, the same hazard `GiftContextRegistry.register` guards
   * against for gift context handlers.
   */
  register(strategy: IPkScoreStrategy): void {
    if (this.strategies.has(strategy.key)) {
      throw new Error(`PK score strategy already registered for key ${strategy.key}`);
    }
    this.strategies.set(strategy.key, strategy);
    this.logger.log(`registered PK score strategy: ${strategy.key}`);
  }

  /**
   * Compose the multiplier for one gift leg.
   *
   * Only strategies named in THIS battle's frozen snapshot participate, so an
   * admin registering a new strategy mid-battle cannot change the rules of a
   * battle already in flight.
   *
   * A throwing strategy contributes 0 rather than propagating: this runs inside
   * the gift's money transaction, and a VIP lookup failure must never roll back
   * a paid gift. The floor at base and the ceiling at capBps together mean a
   * misconfigured strategy can neither erase score nor mint unbounded score.
   */
  async resolve(ctx: PkScoreContext): Promise<number> {
    const active = ctx.snapshot.strategies;
    let bonus = 0;
    for (const s of this.strategies.values()) {
      if (!active.includes(s.key)) continue;
      try {
        bonus += await s.bonusBps(ctx);
      } catch (err) {
        this.logger.warn(`PK score strategy ${s.key} failed: ${(err as Error).message}`);
      }
    }
    const total = PK_MULTIPLIER_BASE_BPS + bonus;
    if (total < PK_MULTIPLIER_BASE_BPS) return PK_MULTIPLIER_BASE_BPS;
    return Math.min(total, ctx.snapshot.capBps);
  }

  /**
   * Build the frozen snapshot for a battle starting under config `cfg`.
   *
   * VIP has no on/off switch in config — it is the platform's baseline
   * multiplier, gated only by whether the sender actually holds a tier — so it
   * is always in the allow-list. EVENT is conditional: it only joins the
   * allow-list when `eventMultiplierEnabled` is true right now, at battle
   * start. Once written, this list does not change for the life of the
   * battle even if config does.
   */
  snapshot(cfg: VideoRoomPkConfig): PkScoringSnapshot {
    const strategies = ['VIP'];
    if (cfg.eventMultiplierEnabled) strategies.push('EVENT');
    return {
      strategies,
      vipBonusBpsPerTier: cfg.vipBonusBpsPerTier,
      eventBonusBps: cfg.eventBonusBps,
      capBps: cfg.multiplierCapBps,
    };
  }
}
