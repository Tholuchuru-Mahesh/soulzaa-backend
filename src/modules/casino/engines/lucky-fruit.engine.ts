/**
 * Lucky Fruit — pure game engine (symbol list, bonus rules, payout math,
 * outcome selection). No DB, no sockets, no Nest DI — settlement/gateway code
 * consumes these functions.
 *
 * Source of truth (copied verbatim, no rebalancing):
 *   - old backend: controller/socket_controllers/lucky_fruit_socket.js
 *     `SYMBOLS`, `MULTIPLIERS`, and the effective-multiplier block duplicated
 *     in `selectWinningOutcome` (~lines 84-90) and `settleRound` (~lines
 *     113-121). `smallLucky`/`bigLucky` are outcome-only bonus segments —
 *     the old socket rejects bets on them (~line 409).
 * See also docs/superpowers/specs/2026-07-16-greedy-food-lucky-fruit-casino-design.md §5.2.
 *
 * Win rule: a bet wins if the outcome equals the bet symbol exactly (pays
 * that symbol's own multiplier), OR the outcome is `smallLucky` and the bet
 * symbol is one of the 4 SMALL symbols (pays a flat 5×), OR the outcome is
 * `bigLucky` and the bet symbol is one of the 4 BIG symbols (pays that
 * symbol's own multiplier). Every SMALL symbol is itself 5×, so the
 * `smallLucky` flat-5× branch and "the bet symbol's own multiplier" agree in
 * practice — the old code still hard-codes `5` for that branch (not a
 * `MULTIPLIERS[betSymbol]` lookup), so this reproduces that literal.
 */
import {
  LUCKY_MULTIPLIERS,
  LUCKY_OUTCOMES,
  LUCKY_BETTABLE,
  LUCKY_SMALL,
  LUCKY_BIG,
} from '../constants/casino.constants';
import { pickLowestLiability, CasinoBetLike } from './liability-selector';

/** All 10 Lucky Fruit wheel outcomes — the 8 bettable symbols plus smallLucky/bigLucky. */
export { LUCKY_OUTCOMES };

/** Whether `symbol` is a valid Lucky Fruit bet target (the 8 fruit symbols only). */
export function isLuckyBettable(symbol: string): boolean {
  return LUCKY_BETTABLE.includes(symbol);
}

/**
 * Payout multiplier a `betSymbol` bet receives when `outcome` wins — 0 if the
 * bet loses, else:
 *   - exact match → that symbol's own multiplier
 *   - `smallLucky` outcome + betSymbol ∈ SMALL → flat 5×
 *   - `bigLucky` outcome + betSymbol ∈ BIG → that symbol's own multiplier
 */
export function luckyEffectiveMultiplier(betSymbol: string, outcome: string): number {
  if (outcome === betSymbol) return LUCKY_MULTIPLIERS[betSymbol] ?? 0;
  if (outcome === 'smallLucky' && LUCKY_SMALL.includes(betSymbol)) return 5;
  if (outcome === 'bigLucky' && LUCKY_BIG.includes(betSymbol))
    return LUCKY_MULTIPLIERS[betSymbol] ?? 0;
  return 0;
}

/**
 * Selects the winning Lucky Fruit outcome for a round's active bets using the
 * shared house-protective lowest-liability selector.
 */
export function selectLuckyOutcome(bets: CasinoBetLike[], rng?: (n: number) => number): string {
  return pickLowestLiability(LUCKY_OUTCOMES, bets, luckyEffectiveMultiplier, rng);
}
