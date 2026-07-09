/**
 * Public contract for the games module — the ONLY surface other modules may
 * depend on (this token/interface or the EVENT_BUS). Internals (entities,
 * repositories, concrete services) stay private.
 *
 * The primary cross-module seam is `settleResult`: a trusted game engine (or an
 * internal service) submits a match's winners/payouts and the platform
 * validates them, pays out via the wallet, and records immutable history. The
 * platform never derives the game outcome itself.
 */
export const GAMES_SERVICE = Symbol('GAMES_SERVICE');

/** A single participant's payout in a settlement submission. */
export interface GamePayout {
  userId: string;
  amount: number;
}

/** Trusted result submission for an active game session. */
export interface GameSettleInput {
  sessionId: string;
  winners: string[];
  payouts: GamePayout[];
  resultData?: Record<string, unknown>;
  /** Actor/service id credited as the settler (audit). */
  settledBy?: string | null;
}

export interface IGamesService {
  /**
   * Validate and settle an active session. Throws if the session is not active,
   * already settled, or the winners/payouts fail anti-cheat validation
   * (non-participant target, duplicate payout, payouts exceeding the pot).
   */
  settleResult(input: GameSettleInput): Promise<unknown>;
}
