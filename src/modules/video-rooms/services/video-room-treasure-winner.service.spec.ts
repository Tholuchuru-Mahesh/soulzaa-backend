import { WinnerSelectionException } from '../exceptions/video-room-treasure.exceptions';
import {
  seededRandom,
  VideoRoomTreasureWinnerService,
  type WinnerSelectionInput,
} from './video-room-treasure-winner.service';

const input = (over: Partial<WinnerSelectionInput> = {}): WinnerSelectionInput => ({
  eligible: ['u1', 'u2', 'u3', 'u4', 'u5'],
  want: 3,
  seed: 'box-1-seed',
  contributions: new Map(),
  activity: new Map(),
  vipTiers: new Map(),
  ...over,
});

describe('seededRandom', () => {
  it('is deterministic for a given seed', () => {
    const a = seededRandom('abc');
    const b = seededRandom('abc');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('differs across seeds', () => {
    expect(seededRandom('abc')()).not.toBe(seededRandom('xyz')());
  });

  it('stays in [0, 1)', () => {
    const rng = seededRandom('abc');
    for (let i = 0; i < 500; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('VideoRoomTreasureWinnerService', () => {
  let service: VideoRoomTreasureWinnerService;

  beforeEach(() => {
    service = new VideoRoomTreasureWinnerService();
  });

  it('registers the five spec algorithms out of the box', () => {
    for (const algo of [
      'RANDOM',
      'WEIGHTED_RANDOM',
      'ACTIVITY_BASED',
      'CONTRIBUTION_BASED',
      'VIP_PRIORITY',
    ]) {
      expect(() => service.select(algo, input())).not.toThrow();
    }
  });

  // A config typo must be loud, not silently change who gets paid.
  it('rejects an unknown algorithm rather than falling back to RANDOM', () => {
    expect(() => service.select('ROULETTE', input())).toThrow(WinnerSelectionException);
  });

  // Reproducibility is the audit requirement: a disputed draw must be
  // re-derivable from (algorithm, version, seed, candidates).
  it('is reproducible for the same seed and candidate list', () => {
    const a = service.select('RANDOM', input());
    const b = service.select('RANDOM', input());
    expect(a.winners).toEqual(b.winners);
    expect(a.version).toBe(1);
  });

  it('draws different winners for a different seed', () => {
    const a = service.select('RANDOM', input({ seed: 'seed-a' }));
    const b = service.select('RANDOM', input({ seed: 'seed-b' }));
    expect(a.winners).not.toEqual(b.winners);
  });

  it('never draws the same user twice', () => {
    const { winners } = service.select('RANDOM', input({ want: 5 }));
    expect(new Set(winners).size).toBe(5);
  });

  it('returns everyone when fewer are eligible than wanted', () => {
    const { winners } = service.select('RANDOM', input({ eligible: ['u1', 'u2'], want: 3 }));
    expect([...winners].sort()).toEqual(['u1', 'u2']);
  });

  it('returns nothing when nobody is eligible', () => {
    expect(service.select('RANDOM', input({ eligible: [] })).winners).toEqual([]);
  });

  it('only ever draws from the eligible list', () => {
    const eligible = ['u1', 'u2', 'u3'];
    const { winners } = service.select('WEIGHTED_RANDOM', input({ eligible, want: 3 }));
    for (const w of winners) expect(eligible).toContain(w);
  });

  describe('CONTRIBUTION_BASED', () => {
    it('ranks by contribution, highest first', () => {
      const { winners } = service.select(
        'CONTRIBUTION_BASED',
        input({
          contributions: new Map([
            ['u1', 10n],
            ['u3', 500n],
            ['u5', 80n],
          ]),
        }),
      );
      expect(winners).toEqual(['u3', 'u5', 'u1']);
    });

    // Stable across runs rather than dependent on Map insertion order.
    it('breaks ties on userId', () => {
      const contributions = new Map([
        ['u2', 100n],
        ['u1', 100n],
      ]);
      const a = service.select(
        'CONTRIBUTION_BASED',
        input({ eligible: ['u2', 'u1'], want: 2, contributions }),
      );
      const b = service.select(
        'CONTRIBUTION_BASED',
        input({ eligible: ['u1', 'u2'], want: 2, contributions }),
      );
      expect(a.winners).toEqual(['u1', 'u2']);
      expect(b.winners).toEqual(['u1', 'u2']);
    });
  });

  describe('WEIGHTED_RANDOM', () => {
    // A lottery that can never pick a non-contributor is a leaderboard wearing
    // a lottery's clothes — the floor weight of 1 is load-bearing.
    it('can still pick a zero-contribution user', () => {
      const { winners } = service.select(
        'WEIGHTED_RANDOM',
        input({ eligible: ['u1', 'u2'], want: 2, contributions: new Map([['u1', 1_000_000n]]) }),
      );
      expect([...winners].sort()).toEqual(['u1', 'u2']);
    });

    it('favours the heavier contributor across many seeds', () => {
      let whaleFirst = 0;
      for (let i = 0; i < 200; i++) {
        const { winners } = service.select(
          'WEIGHTED_RANDOM',
          input({
            eligible: ['whale', 'minnow'],
            want: 1,
            seed: `s${i}`,
            contributions: new Map([
              ['whale', 10_000n],
              ['minnow', 1n],
            ]),
          }),
        );
        if (winners[0] === 'whale') whaleFirst += 1;
      }
      expect(whaleFirst).toBeGreaterThan(150);
    });
  });

  describe('VIP_PRIORITY', () => {
    it('favours a higher VIP tier across many seeds', () => {
      let vipFirst = 0;
      for (let i = 0; i < 200; i++) {
        const { winners } = service.select(
          'VIP_PRIORITY',
          input({
            eligible: ['vip', 'plain'],
            want: 1,
            seed: `s${i}`,
            vipTiers: new Map([['vip', 5]]),
          }),
        );
        if (winners[0] === 'vip') vipFirst += 1;
      }
      expect(vipFirst).toBeGreaterThan(120);
    });
  });

  it('accepts a newly registered strategy without touching the selector', () => {
    service.register({
      algorithm: 'ALPHABETICAL',
      version: 7,
      select: (i) => [...i.eligible].sort().slice(0, i.want),
    });
    expect(service.select('ALPHABETICAL', input())).toEqual({
      winners: ['u1', 'u2', 'u3'],
      version: 7,
    });
  });
});
