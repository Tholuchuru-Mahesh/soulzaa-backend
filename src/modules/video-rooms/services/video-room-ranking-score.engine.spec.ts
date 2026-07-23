import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingScoreEngine } from './video-room-ranking-score.engine';

const RAW = {}; // empty namespace → documented defaults
const config = { get: () => RAW } as never;

describe('VideoRoomRankingScoreEngine', () => {
  const engine = new VideoRoomRankingScoreEngine(config);

  describe('hosts', () => {
    it('sums every weighted signal', () => {
      // coins 100*1 + gifts 4*5 + watch 3600*0.01 + peak 12*2 + pkWin 1*500 + treasure 2*50
      // = 100 + 20 + 36 + 24 + 500 + 100 = 780
      expect(
        engine.composite(VideoRoomRankingDimension.HOSTS, {
          coins: 100,
          gifts: 4,
          watchSeconds: 3600,
          peakViewers: 12,
          pkWins: 1,
          treasureEvents: 2,
        }),
      ).toBe(780);
    });

    it('treats absent metrics as zero rather than NaN', () => {
      expect(engine.composite(VideoRoomRankingDimension.HOSTS, { coins: 50 })).toBe(50);
      expect(engine.composite(VideoRoomRankingDimension.HOSTS, {})).toBe(0);
    });

    it('preserves fractional contributions rather than rounding them away', () => {
      // 55 * 0.01 = 0.55. This must NOT be rounded to 1 (or to 0): a ZSET score
      // is an IEEE-754 double and can hold this natively, and rounding inside
      // shared arithmetic that both the incremental and recompute paths call
      // would make those two paths disagree — see the parity test below.
      expect(engine.composite(VideoRoomRankingDimension.HOSTS, { watchSeconds: 55 })).toBe(0.55);
    });
  });

  describe('rooms', () => {
    it('weights engagement signals above raw coins', () => {
      // 1000*1 + 50*10 + 600*0.05 + 2*100 + 1*25 = 1000 + 500 + 30 + 200 + 25 = 1755
      expect(
        engine.composite(VideoRoomRankingDimension.ROOMS, {
          giftCoins: 1000,
          peakViewers: 50,
          avgWatchSeconds: 600,
          pkCount: 2,
          treasureCount: 1,
        }),
      ).toBe(1755);
    });
  });

  describe('pk', () => {
    it('makes a win dominate raw score', () => {
      // 1*1000 + 0*0 + 250*1 + 400*0.5 = 1000 + 250 + 200 = 1450
      expect(
        engine.composite(VideoRoomRankingDimension.PK, {
          wins: 1,
          losses: 0,
          score: 250,
          giftCoins: 400,
        }),
      ).toBe(1450);
    });

    it('scores a loss without a win at the loss weight only', () => {
      expect(engine.composite(VideoRoomRankingDimension.PK, { wins: 0, losses: 1 })).toBe(0);
    });
  });

  describe('pass-through dimensions', () => {
    it('scores gifters by coins spent and receivers by coins received', () => {
      expect(engine.composite(VideoRoomRankingDimension.GIFTERS, { coinsSpent: 900 })).toBe(900);
      expect(engine.composite(VideoRoomRankingDimension.RECEIVERS, { coinsReceived: 700 })).toBe(
        700,
      );
    });

    it('scores treasure by coins won', () => {
      expect(engine.composite(VideoRoomRankingDimension.TREASURE, { treasureCoins: 250 })).toBe(
        250,
      );
    });

    it('scores vip by ordinal, using coins spent only as a tiebreak', () => {
      const l5 = engine.composite(VideoRoomRankingDimension.VIP, { vipOrdinal: 5, coinsSpent: 10 });
      const l4 = engine.composite(VideoRoomRankingDimension.VIP, {
        vipOrdinal: 4,
        coinsSpent: 9_999_999,
      });
      // A higher VIP level must outrank any amount of spend at a lower level.
      expect(l5).toBeGreaterThan(l4);
    });

    it('clamps the spend tiebreak so it can never reach a full VIP level stride', () => {
      // Without a clamp, coinsSpent >= 1_000_000_000 (VIP_LEVEL_STRIDE) would let
      // a lower-level whale tie or beat the level above them. Lifetime coin
      // totals are stored as BigInt precisely because they can get this large,
      // even though today's top VIP tier only requires 15,000,000 to reach.
      const level4WithAbsurdSpend = engine.composite(VideoRoomRankingDimension.VIP, {
        vipOrdinal: 4,
        coinsSpent: 5_000_000_000_000,
      });
      const level5WithNoSpend = engine.composite(VideoRoomRankingDimension.VIP, {
        vipOrdinal: 5,
        coinsSpent: 0,
      });
      expect(level4WithAbsurdSpend).toBeLessThan(level5WithNoSpend);
    });
  });

  describe('deltaFor', () => {
    it('equals composite — the incremental and recompute paths must not diverge', () => {
      const metrics = { coins: 100, gifts: 4 };
      expect(engine.deltaFor(VideoRoomRankingDimension.HOSTS, metrics)).toBe(
        engine.composite(VideoRoomRankingDimension.HOSTS, metrics),
      );
    });

    it('sums to the same score as one recompute call over the summed metrics (fractional weight)', () => {
      // This is the parity regression guard for the rounding fix: 1000 incremental
      // pings of 55 watched seconds each (hostWatchSecondWeight = 0.01, so each
      // ping alone contributes a sub-1 amount) must land within floating-point
      // tolerance of a single recompute over the summed 55,000 seconds. Rounding
      // inside the shared arithmetic used to make these diverge by ~82%
      // (1000 vs 550) because every sub-0.5 contribution rounded to zero or one
      // independently of the others.
      let incrementalTotal = 0;
      for (let i = 0; i < 1000; i += 1) {
        incrementalTotal += engine.deltaFor(VideoRoomRankingDimension.HOSTS, { watchSeconds: 55 });
      }
      const recomputeTotal = engine.composite(VideoRoomRankingDimension.HOSTS, {
        watchSeconds: 55_000,
      });
      expect(incrementalTotal).toBeCloseTo(recomputeTotal, 6);
    });
  });

  it('never returns NaN or a negative zero for empty input on any dimension', () => {
    for (const dim of Object.values(VideoRoomRankingDimension)) {
      const score = engine.composite(dim, {});
      expect(Number.isFinite(score)).toBe(true);
      expect(Object.is(score, -0)).toBe(false);
    }
  });
});
