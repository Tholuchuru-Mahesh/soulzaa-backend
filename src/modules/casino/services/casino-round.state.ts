/**
 * In-memory per-game round state held by `CasinoLoopService` — one instance
 * per `CasinoGame`, owned by whichever process currently holds the leader
 * lock (see `casino-loop.service.ts`). NOT persisted beyond what
 * `CasinoRound`/`CasinoBet` rows already capture: `roundId` anchors back to
 * the DB, `poolBets` is a once-per-tick cache of `CasinoBet` rows (so a
 * failover reconstructs the pool from the DB, per docs/superpowers/specs/
 * 2026-07-16-greedy-food-lucky-fruit-casino-design.md §5.4), and
 * `history`/`lastWinners` are the only two fields that don't independently
 * exist elsewhere (carried forward round-to-round in memory, exactly like
 * the old app's module-level `resultsHistory`/`lastWinners` globals).
 *
 * Deliberately plain data (no methods) — a `CasinoRoundState` is what
 * `CasinoLoopService.getState(game)` hands the (Task 11) gateway for its
 * `*_sync` reply, and a plain object is trivially safe to spread into a
 * socket payload.
 */
import { PHASE_SECONDS, type CasinoPhase } from '../constants/casino.constants';

/** A single top-N winner as broadcast on `*_results`/`*_settlement` — username-resolved, never a raw userId. */
export interface CasinoRoundWinnerView {
  username: string;
  amount: number;
}

export interface CasinoRoundState {
  /** `null` only before this game's very first round has been created. */
  roundId: string | null;
  roundNumber: number | null;
  phase: CasinoPhase;
  secondsRemaining: number;
  /** Winning outcomes, newest first, capped at `HISTORY_LEN` (8). */
  history: string[];
  /** Top `TOP_WINNERS` (3) winners of the most recently settled round. */
  lastWinners: CasinoRoundWinnerView[];
  /** Set once the betting→spinning transition locks in an outcome; cleared on the next fresh round. */
  winningOutcome: string | null;
  /** Item/symbol → total staked this round, refreshed from the DB once per tick. */
  poolBets: Record<string, number>;
}

/** A brand-new round's state — always `betting`, full timer, no outcome yet. */
export function freshRoundState(
  roundId: string,
  roundNumber: number,
  carryOver: Pick<CasinoRoundState, 'history' | 'lastWinners'> = { history: [], lastWinners: [] },
): CasinoRoundState {
  return {
    roundId,
    roundNumber,
    phase: 'betting',
    secondsRemaining: PHASE_SECONDS.betting,
    history: carryOver.history,
    lastWinners: carryOver.lastWinners,
    winningOutcome: null,
    poolBets: {},
  };
}

/** Push `outcome` onto the rolling history (newest first), capped at `cap` entries. */
export function pushHistory(history: string[], outcome: string, cap: number): string[] {
  return [outcome, ...history].slice(0, cap);
}
