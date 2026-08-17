import {
  GRADE_BANDS,
  SCORE_WEIGHTS,
  gradeFor,
  scoreMember,
  topPercentFor,
  type ScoreInputs,
} from './member-score.constants';

const NOTHING: ScoreInputs = { loginDays: 0, roomsJoined: 0, giftsSent: 0, giftsReceived: 0 };

describe('member score', () => {
  it('sums its weights to exactly 1', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((sum, w) => sum + w.weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('scores a member with no activity as 0', () => {
    expect(scoreMember(NOTHING)).toBe(0);
  });

  it('scores a member at every cap as 100', () => {
    expect(scoreMember({ loginDays: 30, roomsJoined: 30, giftsSent: 50, giftsReceived: 50 })).toBe(
      100,
    );
  });

  it('caps each input, so one runaway figure cannot exceed 100', () => {
    expect(
      scoreMember({ loginDays: 900, roomsJoined: 900, giftsSent: 9000, giftsReceived: 9000 }),
    ).toBe(100);
  });

  it("reproduces the spec's worked example", () => {
    // 0.30*(12/30) + 0.25*(18/30) + 0.25*1 + 0.20*1 = 0.72
    expect(scoreMember({ loginDays: 12, roomsJoined: 18, giftsSent: 50, giftsReceived: 50 })).toBe(
      72,
    );
  });

  it('scales every cap with the window, so a 7-day score stays on the 0-100 axis', () => {
    // Caps become 7, 7, 11.67, 11.67 — all met, so a full 7-day week is 100.
    expect(scoreMember({ loginDays: 7, roomsJoined: 7, giftsSent: 12, giftsReceived: 12 }, 7)).toBe(
      100,
    );
  });
});

describe('gradeFor', () => {
  it.each([
    [100, 'EXCELLENT'],
    [80, 'EXCELLENT'],
    [79, 'GOOD'],
    [60, 'GOOD'],
    [59, 'FAIR'],
    [40, 'FAIR'],
    [39, 'NEEDS_WORK'],
    [0, 'NEEDS_WORK'],
  ])('grades %i as %s', (score, code) => {
    expect(gradeFor(score).code).toBe(code);
  });

  it('orders its bands high to low, so the first match is the right one', () => {
    const mins = GRADE_BANDS.map((b) => b.min);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
  });
});

describe('topPercentFor', () => {
  it('places the 7th of 7541 members in the top 1%', () => {
    expect(topPercentFor(7, 7541)).toBe(1);
  });

  it('places the 754th of 7541 members in the top 10%', () => {
    expect(topPercentFor(754, 7541)).toBe(10);
  });

  it('never reports top 0%, because rank 1 is still inside the population', () => {
    expect(topPercentFor(1, 7541)).toBe(1);
  });

  it('declines to rank a group too small for a percentile to mean anything', () => {
    // Telling the 2nd of 3 members they are "top 67%" is noise, not a fact.
    expect(topPercentFor(2, 3)).toBeNull();
    expect(topPercentFor(1, 9)).toBeNull();
    expect(topPercentFor(1, 10)).toBe(10);
  });
});
