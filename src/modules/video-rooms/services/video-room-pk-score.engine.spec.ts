import { PK_MULTIPLIER_BASE_BPS } from '../constants/video-room-pk.constants';
import { VideoRoomPkScoreEngine, type IPkScoreStrategy } from './video-room-pk-score.engine';

const ctx = (snapshot: Partial<{ strategies: string[]; capBps: number }> = {}) =>
  ({
    roomId: 'r',
    battleId: 'b',
    senderId: 's',
    receiverId: 'x',
    baseAmount: 100,
    snapshot: {
      strategies: snapshot.strategies ?? ['VIP', 'EVENT'],
      vipBonusBpsPerTier: 500,
      eventBonusBps: 2000,
      capBps: snapshot.capBps ?? 30_000,
    },
    db: {} as never,
  }) as never;

const strat = (key: string, bps: number): IPkScoreStrategy => ({ key, bonusBps: () => bps });

describe('VideoRoomPkScoreEngine', () => {
  it('returns the 1.0x base when nothing is registered', async () => {
    expect(await new VideoRoomPkScoreEngine().resolve(ctx())).toBe(PK_MULTIPLIER_BASE_BPS);
  });

  // Additive, NOT multiplicative: 2x + 2x is 3x here, not 4x. Multiplicative
  // stacking compounds and makes the cap arbitrary.
  it('adds bonuses onto the base rather than multiplying them', async () => {
    const e = new VideoRoomPkScoreEngine();
    e.register(strat('VIP', 10_000));
    e.register(strat('EVENT', 10_000));
    expect(await e.resolve(ctx())).toBe(30_000);
  });

  it('caps the composed multiplier', async () => {
    const e = new VideoRoomPkScoreEngine();
    e.register(strat('VIP', 50_000));
    expect(await e.resolve(ctx({ capBps: 20_000 }))).toBe(20_000);
  });

  // The snapshot is the frozen rule set. A strategy registered in code but
  // absent from THIS battle's snapshot must not apply to it.
  it('ignores a strategy that is not in the battle snapshot', async () => {
    const e = new VideoRoomPkScoreEngine();
    e.register(strat('VIP', 5_000));
    expect(await e.resolve(ctx({ strategies: ['EVENT'] }))).toBe(PK_MULTIPLIER_BASE_BPS);
  });

  // A VIP-lookup failure must never fail a paid gift.
  it('treats a throwing strategy as contributing zero', async () => {
    const e = new VideoRoomPkScoreEngine();
    e.register({
      key: 'VIP',
      bonusBps: () => {
        throw new Error('vip down');
      },
    });
    e.register(strat('EVENT', 1_000));
    expect(await e.resolve(ctx())).toBe(11_000);
  });

  it('refuses a duplicate strategy key', () => {
    const e = new VideoRoomPkScoreEngine();
    e.register(strat('VIP', 1));
    expect(() => e.register(strat('VIP', 2))).toThrow();
  });

  it('never returns less than the base', async () => {
    const e = new VideoRoomPkScoreEngine();
    e.register(strat('VIP', -99_000));
    expect(await e.resolve(ctx())).toBe(PK_MULTIPLIER_BASE_BPS);
  });
});
