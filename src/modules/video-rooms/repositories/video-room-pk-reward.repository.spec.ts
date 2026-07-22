import { VideoRoomPkRewardKind, WalletCurrency } from '@prisma/client';
import { VideoRoomPkRewardRepository } from './video-room-pk-reward.repository';

const prisma = () =>
  ({
    videoRoomPkRewardPool: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    videoRoomPkReward: {
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  }) as never;

describe('VideoRoomPkRewardRepository', () => {
  // `battleId @unique` is the mint-once guard: a replayed settlement lands on
  // P2002, which is the SUCCESS path for a retry, not a failure.
  it('createPool reports created:false when the battle already has a pool', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRewardRepository(db);
    const pools = (
      db as never as { videoRoomPkRewardPool: { create: jest.Mock; findUnique: jest.Mock } }
    ).videoRoomPkRewardPool;
    pools.create.mockRejectedValue({ code: 'P2002' });
    pools.findUnique.mockResolvedValue({ id: 'p1', battleId: 'b1' });

    const result = await repo.createPool({
      battleId: 'b1',
      roomId: 'r1',
      strategy: 'PERCENTAGE',
      sourceAmount: 100n,
      poolAmount: 10n,
      winnerBps: 6000,
      participationBps: 3000,
      bonusBps: 1000,
    });

    expect(result.created).toBe(false);
    expect(result.pool.id).toBe('p1');
  });

  // P2002 followed by a findUnique miss means the violation came from some
  // OTHER constraint, not the battleId replay guard. The original error must
  // be rethrown, not swallowed into a fabricated pool row.
  it('createPool rethrows when P2002 is followed by a findUnique miss', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRewardRepository(db);
    const pools = (
      db as never as { videoRoomPkRewardPool: { create: jest.Mock; findUnique: jest.Mock } }
    ).videoRoomPkRewardPool;
    pools.create.mockRejectedValue({ code: 'P2002' });
    pools.findUnique.mockResolvedValue(null);

    await expect(
      repo.createPool({
        battleId: 'b1',
        roomId: 'r1',
        strategy: 'PERCENTAGE',
        sourceAmount: 100n,
        poolAmount: 10n,
        winnerBps: 6000,
        participationBps: 3000,
        bonusBps: 1000,
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  // Only P2002 is a replay signal. Any other error (connection lost, deadlock)
  // must propagate so BullMQ can retry and eventually dead-letter, without
  // ever consulting findUnique.
  it('createPool propagates a non-P2002 error without calling findUnique', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRewardRepository(db);
    const pools = (
      db as never as { videoRoomPkRewardPool: { create: jest.Mock; findUnique: jest.Mock } }
    ).videoRoomPkRewardPool;
    pools.create.mockRejectedValue(new Error('connection lost'));

    await expect(
      repo.createPool({
        battleId: 'b1',
        roomId: 'r1',
        strategy: 'PERCENTAGE',
        sourceAmount: 100n,
        poolAmount: 10n,
        winnerBps: 6000,
        participationBps: 3000,
        bonusBps: 1000,
      }),
    ).rejects.toThrow('connection lost');
    expect(pools.findUnique).not.toHaveBeenCalled();
  });

  // A duplicate reward row means this recipient was already paid; returning
  // null here (not a thrown error) tells the caller to skip the wallet credit.
  it('createReward returns null on a duplicate rather than throwing', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRewardRepository(db);
    (
      db as never as { videoRoomPkReward: { create: jest.Mock } }
    ).videoRoomPkReward.create.mockRejectedValue({ code: 'P2002' });

    expect(
      await repo.createReward({
        battleId: 'b1',
        roomId: 'r1',
        userId: 'u1',
        kind: VideoRoomPkRewardKind.WINNER,
        amount: 10n,
        currency: WalletCurrency.GOLD,
        idempotencyKey: 'pk:b1:u1:WINNER',
      }),
    ).toBeNull();
  });

  // Only P2002 is a replay signal. Any other error (connection lost, deadlock)
  // must propagate so BullMQ can retry and eventually dead-letter.
  it('createReward rethrows a non-P2002 error', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRewardRepository(db);
    (
      db as never as { videoRoomPkReward: { create: jest.Mock } }
    ).videoRoomPkReward.create.mockRejectedValue(new Error('connection lost'));

    await expect(
      repo.createReward({
        battleId: 'b1',
        roomId: 'r1',
        userId: 'u1',
        kind: VideoRoomPkRewardKind.WINNER,
        amount: 10n,
        currency: WalletCurrency.GOLD,
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow('connection lost');
  });

  // The reward↔wallet link is recoverable via idempotencyKey even without
  // this, but a permanently-null column is a silent trap for direct queries.
  it('setWalletTxnId patches the reward row with the wallet transaction id', async () => {
    const db = prisma();
    const repo = new VideoRoomPkRewardRepository(db);
    const rewards = (db as never as { videoRoomPkReward: { update: jest.Mock } }).videoRoomPkReward;
    rewards.update.mockResolvedValue({ id: 'r1', walletTxnId: 'tx-1' });

    const result = await repo.setWalletTxnId('r1', 'tx-1');

    expect(rewards.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { walletTxnId: 'tx-1' },
    });
    expect(result.walletTxnId).toBe('tx-1');
  });
});
