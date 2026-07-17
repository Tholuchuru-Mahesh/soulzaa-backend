import { pickLowestLiability, CasinoBetLike } from './liability-selector';

// exact-match effMult: pays 10x only when bet item === outcome
const effMult = (item: string, outcome: string) => (item === outcome ? 10 : 0);

describe('pickLowestLiability', () => {
  it('picks the outcome that pays the least', () => {
    const bets: CasinoBetLike[] = [{ item: 'a', amount: 100 }]; // only 'a' bet
    // liability(a)=1000, liability(b)=0 -> must pick 'b'
    const out = pickLowestLiability(['a', 'b'], bets, effMult);
    expect(out).toBe('b');
  });

  it('is deterministic given an rng for tie-breaks (all-zero liabilities)', () => {
    const out = pickLowestLiability(['a', 'b', 'c'], [], effMult, () => 2);
    expect(out).toBe('c'); // rng returns index 2
  });

  it('breaks ties only among minimum-liability outcomes', () => {
    const bets: CasinoBetLike[] = [{ item: 'a', amount: 100 }];
    // a=1000, b=0, c=0 -> candidates [b,c]; rng()=0 -> 'b'
    const out = pickLowestLiability(['a', 'b', 'c'], bets, effMult, () => 0);
    expect(out).toBe('b');
  });

  it("never returns an outcome whose liability exceeds another outcome's (house-min property)", () => {
    // Mixed bets across several items with a game-like multiplier table.
    const multipliers: Record<string, number> = {
      a: 5,
      b: 5,
      c: 10,
      d: 15,
      e: 45,
    };
    const gameEffMult = (item: string, outcome: string) =>
      item === outcome ? (multipliers[item] ?? 0) : 0;
    const bets: CasinoBetLike[] = [
      { item: 'a', amount: 100 },
      { item: 'a', amount: 50 },
      { item: 'b', amount: 200 },
      { item: 'c', amount: 30 },
      { item: 'd', amount: 10 },
      { item: 'e', amount: 1 },
    ];
    const outcomes = ['a', 'b', 'c', 'd', 'e'];

    const liabilityOf = (outcome: string) =>
      bets.reduce((sum, bet) => sum + bet.amount * gameEffMult(bet.item, outcome), 0);

    const chosen = pickLowestLiability(outcomes, bets, gameEffMult);
    const chosenLiability = liabilityOf(chosen);
    for (const o of outcomes) {
      expect(chosenLiability).toBeLessThanOrEqual(liabilityOf(o));
    }
  });

  it('breaks ties uniformly at random: every tied candidate is reachable', () => {
    // No bets at all -> every outcome ties at liability 0.
    const outcomes = ['a', 'b', 'c', 'd'];
    const seen = new Set<string>();
    for (let i = 0; i < outcomes.length; i++) {
      // Inject an rng that deterministically selects index i, proving each
      // candidate index is a reachable pick (i.e. the candidate set really
      // does include every tied outcome, not a subset).
      const out = pickLowestLiability(outcomes, [], effMult, () => i);
      seen.add(out);
    }
    expect(seen).toEqual(new Set(outcomes));
  });

  it('with zero bets, all liabilities are 0 and selection is uniform over all outcomes', () => {
    const outcomes = ['a', 'b', 'c'];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const iterations = 3000;
    for (let i = 0; i < iterations; i++) {
      const out = pickLowestLiability(outcomes, [], effMult);
      counts[out] = (counts[out] ?? 0) + 1;
    }
    // Every outcome must appear (uniform over the full candidate set, not a subset).
    for (const o of outcomes) {
      expect(counts[o]).toBeGreaterThan(0);
    }
    // Roughly uniform: with 3000 draws over 3 outcomes, expect ~1000 each;
    // allow generous slack to keep this test non-flaky.
    for (const o of outcomes) {
      expect(counts[o]).toBeGreaterThan(iterations / outcomes.length / 3);
      expect(counts[o]).toBeLessThan((iterations / outcomes.length) * 3);
    }
  });

  it('uses crypto.randomInt by default (no injected rng) and stays within bounds', () => {
    // Sanity check the default rng seam actually produces a valid outcome
    // (exercises the `randomInt` default branch, not just the injected-rng seam).
    const out = pickLowestLiability(['a', 'b', 'c'], [], effMult);
    expect(['a', 'b', 'c']).toContain(out);
  });
});
