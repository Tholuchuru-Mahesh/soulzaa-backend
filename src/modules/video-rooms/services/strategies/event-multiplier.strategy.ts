import { Injectable, OnModuleInit } from '@nestjs/common';
import type { IPkScoreStrategy, PkScoreContext } from '../video-room-pk-score.engine';
import { VideoRoomPkScoreEngine } from '../video-room-pk-score.engine';

/**
 * Flat event-driven bonus for a PK gift leg (VR-12 Task 11).
 *
 * Whether EVENT applies to a battle at all is already decided by the frozen
 * snapshot: `VideoRoomPkScoreEngine.snapshot()` only lists `'EVENT'` in
 * `strategies` when `eventMultiplierEnabled` was true at battle start, and
 * `resolve()` never calls a strategy whose key is absent from that list. This
 * strategy re-checks that same membership defensively — so a direct call
 * (bypassing the engine) still degrades to 0 rather than minting a bonus — and
 * otherwise its only job is to supply the configured rate.
 */
@Injectable()
export class EventMultiplierStrategy implements IPkScoreStrategy, OnModuleInit {
  readonly key = 'EVENT';

  constructor(private readonly engine: VideoRoomPkScoreEngine) {}

  onModuleInit(): void {
    this.engine.register(this);
  }

  bonusBps(ctx: PkScoreContext): number {
    return ctx.snapshot.strategies.includes(this.key) ? ctx.snapshot.eventBonusBps : 0;
  }
}
