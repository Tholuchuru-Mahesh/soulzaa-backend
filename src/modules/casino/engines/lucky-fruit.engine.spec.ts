import {
  luckyEffectiveMultiplier,
  isLuckyBettable,
  selectLuckyOutcome,
  LUCKY_OUTCOMES,
} from './lucky-fruit.engine';
import { CasinoBetLike } from './liability-selector';

const EXPECTED_MULTIPLIERS: Record<string, number> = {
  pineapple: 5,
  kiwi: 5,
  blueberry: 5,
  peach: 5,
  pear: 10,
  coconut: 15,
  dragonFruit: 25,
  muskmelon: 45,
};

const SMALL = ['pineapple', 'kiwi', 'blueberry', 'peach'];
const BIG = ['pear', 'coconut', 'dragonFruit', 'muskmelon'];

describe('lucky-fruit engine', () => {
  describe('outcome universe', () => {
    it('has all 10 outcomes (8 bettable symbols + smallLucky + bigLucky)', () => {
      expect(LUCKY_OUTCOMES.sort()).toEqual([...SMALL, ...BIG, 'smallLucky', 'bigLucky'].sort());
    });

    it('the 8 fruit symbols are bettable', () => {
      for (const symbol of [...SMALL, ...BIG]) {
        expect(isLuckyBettable(symbol)).toBe(true);
      }
    });

    it('smallLucky and bigLucky are NOT bettable (outcome-only bonus segments)', () => {
      expect(isLuckyBettable('smallLucky')).toBe(false);
      expect(isLuckyBettable('bigLucky')).toBe(false);
    });

    it('rejects an unknown symbol', () => {
      expect(isLuckyBettable('nope')).toBe(false);
      expect(isLuckyBettable('')).toBe(false);
    });
  });

  describe('exact-match wins pay the symbol its own multiplier', () => {
    it.each(Object.entries(EXPECTED_MULTIPLIERS))(
      '%s bet on %s outcome pays %i×',
      (symbol, multiplier) => {
        expect(luckyEffectiveMultiplier(symbol, symbol)).toBe(multiplier);
      },
    );
  });

  describe('plain losses (no exact match, no lucky bonus) pay 0', () => {
    it('pineapple bet loses under pear outcome', () => {
      expect(luckyEffectiveMultiplier('pineapple', 'pear')).toBe(0);
    });
    it('muskmelon bet loses under coconut outcome', () => {
      expect(luckyEffectiveMultiplier('muskmelon', 'coconut')).toBe(0);
    });
    it('pear bet loses under kiwi outcome', () => {
      expect(luckyEffectiveMultiplier('pear', 'kiwi')).toBe(0);
    });
  });

  describe('smallLucky outcome pays every SMALL bet at a flat 5x', () => {
    it.each(SMALL)('%s bet wins under smallLucky outcome', (symbol) => {
      expect(luckyEffectiveMultiplier(symbol, 'smallLucky')).toBe(5);
    });

    it('does NOT pay a BIG bet (smallLucky does not cross classes)', () => {
      for (const symbol of BIG) {
        expect(luckyEffectiveMultiplier(symbol, 'smallLucky')).toBe(0);
      }
    });
  });

  describe("bigLucky outcome pays every BIG bet at that symbol's own multiplier", () => {
    it.each(BIG)('%s bet wins under bigLucky outcome', (symbol) => {
      expect(luckyEffectiveMultiplier(symbol, 'bigLucky')).toBe(EXPECTED_MULTIPLIERS[symbol]);
    });

    it('dragonFruit bet pays its own 25× under bigLucky', () => {
      expect(luckyEffectiveMultiplier('dragonFruit', 'bigLucky')).toBe(25);
    });

    it('does NOT pay a SMALL bet (bigLucky does not cross classes)', () => {
      for (const symbol of SMALL) {
        expect(luckyEffectiveMultiplier(symbol, 'bigLucky')).toBe(0);
      }
    });
  });

  describe('selectLuckyOutcome', () => {
    it('spins to an outcome that does not pay a lone muskmelon bet', () => {
      const out = selectLuckyOutcome([{ item: 'muskmelon', amount: 100 }], () => 0);
      expect(luckyEffectiveMultiplier('muskmelon', out)).toBe(0);
    });

    it('returns the house-minimum-liability outcome for a representative bet spread', () => {
      const bets: CasinoBetLike[] = [
        { item: 'pineapple', amount: 100 },
        { item: 'kiwi', amount: 50 },
        { item: 'pear', amount: 200 },
        { item: 'muskmelon', amount: 10 },
      ];
      const liabilityOf = (outcome: string) =>
        bets.reduce((sum, b) => sum + b.amount * luckyEffectiveMultiplier(b.item, outcome), 0);

      const chosen = selectLuckyOutcome(bets);
      const chosenLiability = liabilityOf(chosen);
      for (const outcome of LUCKY_OUTCOMES) {
        expect(chosenLiability).toBeLessThanOrEqual(liabilityOf(outcome));
      }
    });

    it('with zero bets, is deterministic given an injected rng', () => {
      const out = selectLuckyOutcome([], () => 0);
      expect(out).toBe(LUCKY_OUTCOMES[0]);
    });
  });
});
