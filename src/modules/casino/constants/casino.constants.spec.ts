import {
  CASINO_CHIPS,
  casinoBetIdempotencyKey,
  GREEDY_MULTIPLIERS,
  LUCKY_MULTIPLIERS,
  GREEDY_ITEMS,
  LUCKY_BETTABLE,
  LUCKY_OUTCOMES,
  PHASE_SECONDS,
} from './casino.constants';

describe('casino constants', () => {
  it('has the 5 whitelisted chips', () => {
    expect(CASINO_CHIPS).toEqual([100, 500, 1000, 10000, 50000]);
  });
  it('greedy multipliers match old app', () => {
    expect(GREEDY_MULTIPLIERS).toMatchObject({
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
    });
    expect(GREEDY_ITEMS).toHaveLength(10);
  });
  it('lucky multipliers match old app; lucky segments not bettable', () => {
    expect(LUCKY_MULTIPLIERS).toMatchObject({
      pineapple: 5,
      kiwi: 5,
      blueberry: 5,
      peach: 5,
      pear: 10,
      coconut: 15,
      dragonFruit: 25,
      muskmelon: 45,
    });
    expect(LUCKY_BETTABLE).toHaveLength(8);
    expect(LUCKY_OUTCOMES).toHaveLength(10);
    expect(LUCKY_BETTABLE).not.toContain('smallLucky');
    expect(LUCKY_OUTCOMES).toContain('smallLucky');
  });
  it('phase durations 30/10/5', () => {
    expect(PHASE_SECONDS).toEqual({ betting: 30, spinning: 10, results: 5 });
  });
  it('casino bet idempotency key is per-tap (keyed by clientBetId, not by item)', () => {
    expect(casinoBetIdempotencyKey('r1', 'u1', 'tap-1')).toBe('casino-bet:r1:u1:tap-1');
    expect(casinoBetIdempotencyKey('r1', 'u1', 'tap-2')).not.toBe(
      casinoBetIdempotencyKey('r1', 'u1', 'tap-1'),
    );
  });
});
