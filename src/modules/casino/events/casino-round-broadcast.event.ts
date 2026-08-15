import { CasinoGame } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Fired by `CasinoLoopService` for EVERY global `/casino` broadcast it makes
 * (ticks, spins, results/settlements, new-round announcements, Lucky sync) —
 * the single-writer source for the room-scoped casino mirror. Only the loop's
 * leader-locked instance ever broadcasts (see `casino-loop.service.ts`), so
 * exactly one process publishes these and the room mirror fan-out is naturally
 * single-writer too: no cross-instance duplicates.
 *
 * `RoomCasinoWindowListener` subscribes and re-emits the SAME event + payload
 * verbatim into every active room-window session room on the `/games`
 * namespace, so audio-room spectators receive the authoritative casino state
 * (same names/payloads as the global table) without joining `/casino` — and a
 * user from another room never receives it (their `/games` join is denied).
 */
export const CASINO_ROUND_BROADCAST = 'casino.round_broadcast';

export class CasinoRoundBroadcastEvent extends DomainEvent<{
  game: CasinoGame;
  /** The global casino event name, e.g. `greedy_food_tick` (see CASINO_EVENTS). */
  event: string;
  /** The exact payload the global room received. */
  payload: unknown;
}> {
  readonly name = CASINO_ROUND_BROADCAST;
}
