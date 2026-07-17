import {
  greedyEffectiveMultiplier,
  isGreedyBettable,
  selectGreedyOutcome,
  GREEDY_OUTCOMES,
} from './greedy-food.engine';
import { CasinoBetLike } from './liability-selector';

const EXPECTED_MULTIPLIERS: Record<string, number> = {
  carrot: 5,
  corn: 5,
  broccoli: 5,
  tomato: 5,
  burger: 10,
  chicken: 15,
  mutton: 25,
  crab: 45,
  vegSalad: 5,
  nonVegSalad: 10,
};

const VEG_ITEMS = ['carrot', 'corn', 'broccoli', 'tomato'];
const NON_VEG_ITEMS = ['burger', 'chicken', 'mutton', 'crab'];

describe('greedy-food engine', () => {
  describe('outcome universe', () => {
    it('has all 10 items as outcomes', () => {
      expect(GREEDY_OUTCOMES.sort()).toEqual(Object.keys(EXPECTED_MULTIPLIERS).sort());
    });

    it('all 10 items are bettable incl. both salads', () => {
      for (const item of Object.keys(EXPECTED_MULTIPLIERS)) {
        expect(isGreedyBettable(item)).toBe(true);
      }
    });

    it('rejects an unknown item', () => {
      expect(isGreedyBettable('nope')).toBe(false);
      expect(isGreedyBettable('')).toBe(false);
    });
  });

  describe('exact-match wins pay the bet item multiplier', () => {
    it.each(Object.entries(EXPECTED_MULTIPLIERS))(
      '%s bet on %s outcome pays %i×',
      (item, multiplier) => {
        expect(greedyEffectiveMultiplier(item, item)).toBe(multiplier);
      },
    );
  });

  describe('plain losses (no exact match, no salad bonus) pay 0', () => {
    it('carrot bet loses under burger outcome', () => {
      expect(greedyEffectiveMultiplier('carrot', 'burger')).toBe(0);
    });
    it('crab bet loses under mutton outcome', () => {
      expect(greedyEffectiveMultiplier('crab', 'mutton')).toBe(0);
    });
    it('burger bet loses under corn outcome', () => {
      expect(greedyEffectiveMultiplier('burger', 'corn')).toBe(0);
    });
  });

  describe('vegSalad outcome pays every VEG bet at the BET item multiplier', () => {
    it.each(VEG_ITEMS)('%s bet wins under vegSalad outcome', (item) => {
      expect(greedyEffectiveMultiplier(item, 'vegSalad')).toBe(EXPECTED_MULTIPLIERS[item]);
    });

    it('does NOT pay a NON_VEG bet (cross-class salad does not pay)', () => {
      for (const item of NON_VEG_ITEMS) {
        expect(greedyEffectiveMultiplier(item, 'vegSalad')).toBe(0);
      }
    });

    it('a direct vegSalad bet also wins under vegSalad outcome (exact match)', () => {
      expect(greedyEffectiveMultiplier('vegSalad', 'vegSalad')).toBe(5);
    });

    it('a direct vegSalad bet does NOT win under nonVegSalad outcome', () => {
      expect(greedyEffectiveMultiplier('vegSalad', 'nonVegSalad')).toBe(0);
    });
  });

  describe('nonVegSalad outcome pays every NON_VEG bet at the BET item multiplier', () => {
    it.each(NON_VEG_ITEMS)('%s bet wins under nonVegSalad outcome', (item) => {
      expect(greedyEffectiveMultiplier(item, 'nonVegSalad')).toBe(EXPECTED_MULTIPLIERS[item]);
    });

    it('crab bet still pays its own 45× under nonVegSalad (not the outcome multiplier)', () => {
      expect(greedyEffectiveMultiplier('crab', 'nonVegSalad')).toBe(45);
    });

    it('does NOT pay a VEG bet (cross-class salad does not pay)', () => {
      for (const item of VEG_ITEMS) {
        expect(greedyEffectiveMultiplier(item, 'nonVegSalad')).toBe(0);
      }
    });

    it('a direct nonVegSalad bet also wins under nonVegSalad outcome (exact match)', () => {
      expect(greedyEffectiveMultiplier('nonVegSalad', 'nonVegSalad')).toBe(10);
    });

    it('a direct nonVegSalad bet does NOT win under vegSalad outcome', () => {
      expect(greedyEffectiveMultiplier('nonVegSalad', 'vegSalad')).toBe(0);
    });
  });

  describe('selectGreedyOutcome', () => {
    it('spins to an outcome that does not pay a lone crab bet', () => {
      const out = selectGreedyOutcome([{ item: 'crab', amount: 100 }], () => 0);
      expect(greedyEffectiveMultiplier('crab', out)).toBe(0);
    });

    it('returns the house-minimum-liability outcome for a representative bet spread', () => {
      const bets: CasinoBetLike[] = [
        { item: 'carrot', amount: 100 },
        { item: 'corn', amount: 50 },
        { item: 'burger', amount: 200 },
        { item: 'crab', amount: 10 },
        { item: 'vegSalad', amount: 30 },
        { item: 'nonVegSalad', amount: 20 },
      ];
      const liabilityOf = (outcome: string) =>
        bets.reduce((sum, b) => sum + b.amount * greedyEffectiveMultiplier(b.item, outcome), 0);

      const chosen = selectGreedyOutcome(bets);
      const chosenLiability = liabilityOf(chosen);
      for (const outcome of GREEDY_OUTCOMES) {
        expect(chosenLiability).toBeLessThanOrEqual(liabilityOf(outcome));
      }
    });

    it('with zero bets, is deterministic given an injected rng', () => {
      const out = selectGreedyOutcome([], () => 0);
      expect(out).toBe(GREEDY_OUTCOMES[0]);
    });
  });
});
