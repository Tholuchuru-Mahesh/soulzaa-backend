/**
 * Shared, house-protective outcome selector for casino wheel games (Greedy
 * Food, Lucky Fruit). Pure function — no DB, no sockets, no Nest DI.
 *
 * Algorithm (verbatim from the old app; see docs/superpowers/specs/
 * 2026-07-16-greedy-food-lucky-fruit-casino-design.md §5.2 "Liability outcome
 * selector", confirmed against the old selection blocks in:
 *   - old backend: controller/socket_controllers/greedy_food_socket.js (~155-176)
 *   - old backend: controller/socket_controllers/lucky_fruit_socket.js (~75-106,
 *     `selectWinningOutcome`)
 * Both old implementations independently compute, for every candidate
 * outcome, the total the house would have to pay out across all active bets
 * (0 for a losing bet), track the minimum, collect every outcome tied at that
 * minimum, and pick uniformly at random among the tied candidates via
 * `Math.random()`. With zero active bets every outcome's liability is 0, so
 * every outcome ties and the pick is uniform over all outcomes. This module
 * reproduces that exactly, using `node:crypto`'s `randomInt` in place of
 * `Math.random()` for the tie-break (per the design spec).
 */
import { randomInt } from 'node:crypto';

/** A minimal bet shape sufficient to compute liability: which item/symbol was bet, and how much. */
export type CasinoBetLike = { item: string; amount: number };

/**
 * House-protective outcome selection. For each candidate outcome, sum the total
 * the house would pay out; choose an outcome with the minimum total. Ties (incl.
 * the zero-bets case where every outcome pays 0) are broken uniformly at random.
 *
 * @param outcomes candidate wheel outcomes (e.g. all Greedy Food items, or all
 *   Lucky Fruit symbols including the two outcome-only bonus segments).
 * @param bets the active bets for the round being settled.
 * @param effMult given a bet's item and a candidate outcome, returns the payout
 *   multiplier that bet would receive if that outcome won (0 if it loses).
 *   Game-specific (salad/lucky bonus rules etc.) — supplied by the caller.
 * @param rng test seam: given n, returns an int in [0, n). Defaults to
 *   `crypto.randomInt`, mirroring the old app's `Math.random()`-based pick
 *   but using a CSPRNG as specified.
 * @returns the selected winning outcome.
 */
export function pickLowestLiability(
  outcomes: string[],
  bets: CasinoBetLike[],
  effMult: (item: string, outcome: string) => number,
  rng: (n: number) => number = (n) => randomInt(n),
): string {
  let min = Number.POSITIVE_INFINITY;
  const liabilities = outcomes.map((o) => {
    let total = 0;
    for (const b of bets) total += b.amount * effMult(b.item, o);
    if (total < min) min = total;
    return total;
  });
  const candidates = outcomes.filter((_, i) => liabilities[i] === min);
  return candidates[rng(candidates.length)];
}
