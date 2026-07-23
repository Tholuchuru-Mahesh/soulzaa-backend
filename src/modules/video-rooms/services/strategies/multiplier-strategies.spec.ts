import { VipLevel } from 'src/common/enums/vip-level.enum';
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
// `VideoRoomPkRepository.getVipStatus`, so the repository is mocked rather
// than a raw `vipStatus.findUnique` delegate.
const repo = (status: { level: VipLevel } | null) =>
  ({ getVipStatus: jest.fn().mockResolvedValue(status) }) as unknown as VideoRoomPkRepository;

describe('VipMultiplierStrategy', () => {
  it('returns 0 for a sender with no VIP status row', async () => {
    const strategy = new VipMultiplierStrategy(engine(), repo(null));

    expect(await strategy.bonusBps(ctx({}))).toBe(0);
  });

  // NONE is the explicit default level too, not just a missing row.
  it('returns 0 for a sender whose VIP level is explicitly NONE', async () => {
    const strategy = new VipMultiplierStrategy(engine(), repo({ level: VipLevel.NONE }));

    expect(await strategy.bonusBps(ctx({}))).toBe(0);
  });

  it('scales with tier level (GOLD = ordinal 3)', async () => {
    const strategy = new VipMultiplierStrategy(engine(), repo({ level: VipLevel.GOLD }));

    // ordinal(GOLD) = 3 (NONE=0, BRONZE=1, SILVER=2, GOLD=3) * vipBonusBpsPerTier 500
    expect(await strategy.bonusBps(ctx({}, { vipBonusBpsPerTier: 500 }))).toBe(1_500);
  });

  it('scales further for a higher tier (TITAN = ordinal 7)', async () => {
    const strategy = new VipMultiplierStrategy(engine(), repo({ level: VipLevel.TITAN }));

    expect(await strategy.bonusBps(ctx({}, { vipBonusBpsPerTier: 500 }))).toBe(3_500);
  });

  // The gift seam forbids Redis in onSend and this call runs inside the
  // gift's own money transaction, so the strategy MUST forward the
  // caller-supplied `ctx.db` into the repository call, never let the
  // repository fall back to its own module-level PrismaService.
  it('reads through the ctx.db transaction client, not a global Prisma instance', async () => {
    const passedClient = { vipStatus: { findUnique: jest.fn().mockResolvedValue(null) } };
    const mockRepo = repo(null);
    const strategy = new VipMultiplierStrategy(engine(), mockRepo);

    await strategy.bonusBps(ctx(passedClient));

    expect(mockRepo.getVipStatus).toHaveBeenCalledWith('sender-1', passedClient);
  });

  it('registers itself with the engine on module init', () => {
    const e = engine();
    const strategy = new VipMultiplierStrategy(e, repo(null));

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
