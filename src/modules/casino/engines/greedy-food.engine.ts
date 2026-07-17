/**
 * Greedy Food — pure game engine (item list, win rule, payout math, outcome
 * selection). No DB, no sockets, no Nest DI — settlement/gateway code
 * consumes these functions.
 *
 * Source of truth (copied verbatim, no rebalancing):
 *   - old backend: controller/socket_controllers/greedy_food_socket.js
 *     `MULTIPLIERS`, `VEG_ITEMS` / `NON_VEG_ITEMS`, `isWinningBet`, and the
 *     liability-engine block in `lockRoundAndSpin` (~lines 154-176).
 * See also docs/superpowers/specs/2026-07-16-greedy-food-lucky-fruit-casino-design.md §5.2.
 *
 * Win rule: a bet wins if the outcome equals the bet item exactly, OR the
 * outcome is `vegSalad` and the bet item is one of the 4 VEG items, OR the
 * outcome is `nonVegSalad` and the bet item is one of the 4 NON_VEG items.
 * The payout multiplier is ALWAYS the BET item's own multiplier — never the
 * outcome's — so e.g. a `crab` bet still pays 45× when the outcome lands on
 * `nonVegSalad`, and a `carrot` bet pays only 5× even though it also won.
 */
import {
  GREEDY_MULTIPLIERS,
  GREEDY_ITEMS,
  GREEDY_VEG,
  GREEDY_NONVEG,
} from '../constants/casino.constants';
import { pickLowestLiability, CasinoBetLike } from './liability-selector';

/** All 10 Greedy Food wheel outcomes — also the full set of bettable items. */
export { GREEDY_ITEMS as GREEDY_OUTCOMES };

/** Whether `item` is a valid Greedy Food bet target (all 10 keys, salads included). */
export function isGreedyBettable(item: string): boolean {
  return item in GREEDY_MULTIPLIERS;
}

/**
 * Payout multiplier a `betItem` bet receives when `outcome` wins — 0 if the
 * bet loses, else the BET item's own multiplier (never the outcome's).
 */
export function greedyEffectiveMultiplier(betItem: string, outcome: string): number {
  const win =
    outcome === betItem ||
    (outcome === 'vegSalad' && GREEDY_VEG.includes(betItem)) ||
    (outcome === 'nonVegSalad' && GREEDY_NONVEG.includes(betItem));
  return win ? (GREEDY_MULTIPLIERS[betItem] ?? 0) : 0;
}

/**
 * Selects the winning Greedy Food outcome for a round's active bets using the
 * shared house-protective lowest-liability selector.
 */
export function selectGreedyOutcome(bets: CasinoBetLike[], rng?: (n: number) => number): string {
  return pickLowestLiability(GREEDY_ITEMS, bets, greedyEffectiveMultiplier, rng);
}
