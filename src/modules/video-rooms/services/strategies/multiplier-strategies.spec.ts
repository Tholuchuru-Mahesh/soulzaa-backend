import { VideoRoomPkRepository } from '../../repositories/video-room-pk.repository';
import type { PkScoreContext, PkScoringSnapshot } from '../video-room-pk-score.engine';
import { VideoRoomPkScoreEngine } from '../video-room-pk-score.engine';
import { EventMultiplierStrategy } from './event-multiplier.strategy';
import { VipMultiplierStrategy } from './vip-multiplier.strategy';

const snapshot = (overrides: Partial<PkScoringSnapshot> = {}): PkScoringSnapshot => ({
  strategies: ['VIP', 'EVENT'],
  vipBonusBpsPerTier: 500,
  eventBonusBps: 2_000,
  capBps: 30_000,
  ...overrides,
});

const ctx = (db: unknown, overrides: Partial<PkScoringSnapshot> = {}): PkScoreContext =>
  ({
    roomId: 'r',
    battleId: 'b',
    senderId: 'sender-1',
    receiverId: 'receiver-1',
    baseAmount: 100,
    snapshot: snapshot(overrides),
    db,
  }) as never;

const engine = () => new VideoRoomPkScoreEngine();

// The strategy no longer touches Prisma directly — it borrows
// `VideoRoomPkRepository.getWealthLevel`, so the repository is mocked rather
// than a raw `wealthUserProgress.findUnique` delegate.
const repo = (level: number) =>
  ({ getWealthLevel: jest.fn().mockResolvedValue(level) }) as unknown as VideoRoomPkRepository;

describe('VipMultiplierStrategy', () => {
  it('returns 0 for a sender with no Wealth Level progress row', async () => {
    const strategy = new VipMultiplierStrategy(engine(), repo(0));

    expect(await strategy.bonusBps(ctx({}))).toBe(0);
  });

  it('scales with level (level 3)', async () => {
    const strategy = new VipMultiplierStrategy(engine(), repo(3));

    expect(await strategy.bonusBps(ctx({}, { vipBonusBpsPerTier: 500 }))).toBe(1_500);
  });

  it('scales further for a higher level (level 7)', async () => {
    const strategy = new VipMultiplierStrategy(engine(), repo(7));

    expect(await strategy.bonusBps(ctx({}, { vipBonusBpsPerTier: 500 }))).toBe(3_500);
  });

  // The gift seam forbids Redis in onSend and this call runs inside the
  // gift's own money transaction, so the strategy MUST forward the
  // caller-supplied `ctx.db` into the repository call, never let the
  // repository fall back to its own module-level PrismaService.
  it('reads through the ctx.db transaction client, not a global Prisma instance', async () => {
    const passedClient = { wealthUserProgress: { findUnique: jest.fn().mockResolvedValue(null) } };
    const mockRepo = repo(0);
    const strategy = new VipMultiplierStrategy(engine(), mockRepo);

    await strategy.bonusBps(ctx(passedClient));

    expect(mockRepo.getWealthLevel).toHaveBeenCalledWith('sender-1', passedClient);
  });

  it('registers itself with the engine on module init', () => {
    const e = engine();
    const strategy = new VipMultiplierStrategy(e, repo(0));

    strategy.onModuleInit();

    expect(() => e.register({ key: 'VIP', bonusBps: () => 0 })).toThrow();
  });
});

describe('EventMultiplierStrategy', () => {
  it('returns 0 when EVENT is not in the battle snapshot (disabled)', () => {
    const strategy = new EventMultiplierStrategy(engine());

    expect(strategy.bonusBps(ctx({}, { strategies: ['VIP'], eventBonusBps: 2_000 }))).toBe(0);
  });

  it('returns the configured rate when EVENT is in the battle snapshot (enabled)', () => {
    const strategy = new EventMultiplierStrategy(engine());

    expect(strategy.bonusBps(ctx({}, { strategies: ['EVENT'], eventBonusBps: 2_000 }))).toBe(2_000);
  });

  it('registers itself with the engine on module init', () => {
    const e = engine();
    const strategy = new EventMultiplierStrategy(e);

    strategy.onModuleInit();

    expect(() => e.register({ key: 'EVENT', bonusBps: () => 0 })).toThrow();
  });
});
