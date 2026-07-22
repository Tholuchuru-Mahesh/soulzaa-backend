import { Prisma, TreasureRewardKind, TreasureRewardStatus } from '@prisma/client';
import { VideoRoomTreasureRewardRepository } from './video-room-treasure-reward.repository';

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: '6',
    meta: { target: ['boxId'] },
  });

const POOL_INPUT = {
  boxId: 'b1',
  sessionId: 's1',
  roomId: 'r1',
  level: 1,
  strategy: 'PERCENTAGE',
  sourceAmount: 15_000n,
  poolAmount: 1_500n,
  winnerCount: 3,
  algorithm: 'RANDOM',
  algorithmVersion: 1,
  selectionSeed: 'seed',
};

describe('VideoRoomTreasureRewardRepository', () => {
  let prisma: Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock };
  let repo: VideoRoomTreasureRewardRepository;

  beforeEach(() => {
    prisma = {
      treasureRewardPool: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        aggregate: jest.fn(),
        count: jest.fn(),
      },
      treasureWinner: { createMany: jest.fn(), findMany: jest.fn(), count: jest.fn() },
      treasureReward: { createMany: jest.fn(), updateMany: jest.fn() },
      $transaction: jest.fn((arg: unknown) =>
        Array.isArray(arg) ? Promise.all(arg) : (arg as (t: unknown) => unknown)(prisma),
      ),
    } as never;
    repo = new VideoRoomTreasureRewardRepository(prisma as never);
  });

  describe('createPool', () => {
    it('returns the pool on the first write', async () => {
      prisma.treasureRewardPool.create.mockResolvedValue({ id: 'p1' });
      expect(await repo.createPool(POOL_INPUT, prisma as never)).toEqual({ id: 'p1' });
    });

    // boxId @unique is the replay guard: a retried job must not mint twice.
    // A P2002 here means "already done", which is success, not failure.
    it('returns null instead of throwing when the box already has a pool', async () => {
      prisma.treasureRewardPool.create.mockRejectedValue(uniqueViolation());
      expect(await repo.createPool(POOL_INPUT, prisma as never)).toBeNull();
    });

    it('rethrows errors that are not the replay guard', async () => {
      prisma.treasureRewardPool.create.mockRejectedValue(new Error('connection lost'));
      await expect(repo.createPool(POOL_INPUT, prisma as never)).rejects.toThrow('connection lost');
    });
  });

  describe('createWinners', () => {
    it('skips duplicates so a replay cannot add a second win for one user', async () => {
      prisma.treasureWinner.createMany.mockResolvedValue({ count: 3 });
      const n = await repo.createWinners(
        [
          {
            boxId: 'b1',
            sessionId: 's1',
            roomId: 'r1',
            userId: 'u1',
            algorithm: 'RANDOM',
            shareBps: 3333,
            amount: 500n,
            eligibleCount: 10,
            candidateCount: 50,
          },
        ],
        prisma as never,
      );
      expect(n).toBe(3);
      expect(prisma.treasureWinner.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    // Zero eligible is a normal outcome (empty room at unlock), not an error.
    it('is a no-op for an empty draw and never touches the database', async () => {
      expect(await repo.createWinners([], prisma as never)).toBe(0);
      expect(prisma.treasureWinner.createMany).not.toHaveBeenCalled();
    });
  });

  describe('createPendingRewards', () => {
    it('writes every row as PENDING COINS', async () => {
      prisma.treasureReward.createMany.mockResolvedValue({ count: 1 });
      await repo.createPendingRewards(
        [
          {
            sessionId: 's1',
            boxId: 'b1',
            roomId: 'r1',
            level: 1,
            userId: 'u1',
            rank: 1,
            coins: 500n,
          },
        ],
        prisma as never,
      );
      expect(prisma.treasureReward.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            kind: TreasureRewardKind.COINS,
            status: TreasureRewardStatus.PENDING,
          }),
        ],
      });
    });

    it('is a no-op for an empty list', async () => {
      await repo.createPendingRewards([], prisma as never);
      expect(prisma.treasureReward.createMany).not.toHaveBeenCalled();
    });
  });

  describe('markDistributed', () => {
    it('flips only the PENDING row for that box and user', async () => {
      prisma.treasureReward.updateMany.mockResolvedValue({ count: 1 });
      await repo.markDistributed('b1', 'u1', 'wtx1', prisma as never);
      expect(prisma.treasureReward.updateMany).toHaveBeenCalledWith({
        where: { boxId: 'b1', userId: 'u1', status: TreasureRewardStatus.PENDING },
        data: expect.objectContaining({
          status: TreasureRewardStatus.DISTRIBUTED,
          walletTxnId: 'wtx1',
        }),
      });
    });
  });

  describe('markFailed', () => {
    // Must run OUTSIDE the unlock transaction — that transaction is rolling
    // back, so a write inside it would vanish with the failure record.
    it('writes through the base client, never a transaction client', async () => {
      prisma.treasureReward.updateMany.mockResolvedValue({ count: 1 });
      await repo.markFailed('b1', 'DISTRIBUTION', 'wallet timeout');
      expect(prisma.treasureReward.updateMany).toHaveBeenCalledWith({
        where: { boxId: 'b1', status: TreasureRewardStatus.PENDING },
        data: expect.objectContaining({
          status: TreasureRewardStatus.FAILED,
          failureStage: 'DISTRIBUTION',
          lastError: 'wallet timeout',
          attempts: { increment: 1 },
        }),
      });
    });

    it('truncates a runaway error message so one failure cannot bloat the row', async () => {
      prisma.treasureReward.updateMany.mockResolvedValue({ count: 1 });
      await repo.markFailed('b1', 'DISTRIBUTION', 'x'.repeat(2000));
      const data = prisma.treasureReward.updateMany.mock.calls[0][0].data;
      expect(data.lastError).toHaveLength(500);
    });
  });

  describe('statistics', () => {
    it('returns minted totals, defaulting a null aggregate to zero', async () => {
      prisma.treasureRewardPool.count.mockResolvedValue(4);
      prisma.treasureRewardPool.aggregate.mockResolvedValue({
        _sum: { allocatedAmount: 12_000n },
      });
      prisma.treasureWinner.count.mockResolvedValue(12);
      expect(await repo.statistics('r1')).toEqual({
        totalPools: 4,
        totalMinted: 12_000n,
        totalWinners: 12,
      });
    });

    it('reports zero minted for a room that has never unlocked a box', async () => {
      prisma.treasureRewardPool.count.mockResolvedValue(0);
      prisma.treasureRewardPool.aggregate.mockResolvedValue({ _sum: { allocatedAmount: null } });
      prisma.treasureWinner.count.mockResolvedValue(0);
      expect((await repo.statistics('r1')).totalMinted).toBe(0n);
    });
  });
});
