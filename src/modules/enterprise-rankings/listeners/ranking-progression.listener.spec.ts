import { PrismaService } from 'src/infra/prisma/prisma.service';
import type { IEventBus } from 'src/common/events';
import { PROGRESSION_EVENT_NAMES } from 'src/common/events/progression-events';
import { RankingCalculationService } from '../services/ranking-calculation.service';
import { RankingProgressionListener, resolveScoreDelta } from './ranking-progression.listener';

describe('resolveScoreDelta', () => {
  it('reads the magnitude from the configured payload field', () => {
    expect(resolveScoreDelta({ scoreField: 'totalCoinValue' }, { totalCoinValue: 250 })).toBe(250);
  });

  it('coerces a bigint magnitude', () => {
    expect(resolveScoreDelta({ scoreField: 'amount' }, { amount: BigInt(90) })).toBe(90);
  });

  it('uses the configured default for countable events', () => {
    expect(resolveScoreDelta({ defaultDelta: 5 }, { roomId: 'r-1' })).toBe(5);
  });

  it('counts occurrences when the formula configures nothing', () => {
    expect(resolveScoreDelta(null, {})).toBe(1);
  });

  it('falls back when the configured field is missing from the payload', () => {
    expect(resolveScoreDelta({ scoreField: 'absent', defaultDelta: 3 }, {})).toBe(3);
  });
});

describe('RankingProgressionListener', () => {
  const handlers = new Map<string, (e: unknown) => void>();

  const bus = {
    subscribe: jest.fn((name: string, handler: (e: unknown) => void) => {
      handlers.set(name, handler);
    }),
    publish: jest.fn(),
  };
  const prisma = { rankingDefinition: { findMany: jest.fn() } };
  const calculation = { applyScore: jest.fn() };

  const emit = async (name: string, payload: unknown) => {
    handlers.get(name)?.({ payload });
    // Handlers dispatch without awaiting; let the microtask queue drain.
    await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    const listener = new RankingProgressionListener(
      bus as unknown as IEventBus,
      prisma as unknown as PrismaService,
      calculation as unknown as RankingCalculationService,
    );
    listener.onModuleInit();
  });

  it('subscribes to every progression signal', () => {
    expect(bus.subscribe).toHaveBeenCalledTimes(PROGRESSION_EVENT_NAMES.length);
  });

  it('scores only the rankings configured to listen for that event', async () => {
    prisma.rankingDefinition.findMany.mockResolvedValue([
      {
        id: 'rank-gifting',
        entityType: 'USER',
        scoreFormula: { eventCodes: ['gift.sent'], scoreField: 'totalCoinValue' },
      },
      {
        id: 'rank-games',
        entityType: 'USER',
        scoreFormula: { eventCodes: ['game.settled'] },
      },
    ]);

    await emit('gift.sent', { senderId: 'u-1', totalCoinValue: 500 });

    expect(calculation.applyScore).toHaveBeenCalledTimes(1);
    expect(calculation.applyScore).toHaveBeenCalledWith(
      expect.objectContaining({ rankingId: 'rank-gifting', entityId: 'u-1', scoreDelta: 500 }),
    );
  });

  it('ignores events that carry no subject', async () => {
    await emit('audio_room.joined', { roomId: 'r-1' });

    expect(prisma.rankingDefinition.findMany).not.toHaveBeenCalled();
    expect(calculation.applyScore).not.toHaveBeenCalled();
  });

  it('does not let a scoring failure escape into the publisher', async () => {
    prisma.rankingDefinition.findMany.mockRejectedValue(new Error('db down'));

    await expect(emit('gift.sent', { senderId: 'u-1' })).resolves.toBeUndefined();
  });
});
