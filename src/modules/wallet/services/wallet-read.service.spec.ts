import { WalletTxnReason, WalletCurrency, WalletEntryType } from '@prisma/client';
import { WalletReadService } from './wallet-read.service';

function repoMock() {
  return {
    sumByReason: jest.fn(),
    listByReasons: jest.fn(),
    aggregateSignedByCurrency: jest.fn(),
    listHistory: jest.fn(),
  };
}

describe('WalletReadService', () => {
  it('getEarnings sums gifts (EARNINGS) + treasure/pk (GOLD) by source; settlement-ready = earnings balance', async () => {
    const repo = repoMock();
    // One call, not two: gift earnings now come from giftTransaction.aggregate
    // below, so the only sumByReason call is the GOLD treasure/pk one. The
    // stale first `once` was being consumed by that call, leaving it with rows
    // for neither reason.
    repo.sumByReason.mockResolvedValueOnce([
      { reason: WalletTxnReason.TREASURE_BOX, total: 30n },
      { reason: WalletTxnReason.PK_REWARD, total: 40n },
    ]);
    const wallet = {
      getBalance: jest.fn().mockResolvedValue({ gold: 500, game: 0, diamond: 100 }),
    };
    const prisma = {
      giftTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { creatorEarnings: 100n } }),
      },
    };
    const svc = new WalletReadService(repo as never, wallet as never, prisma as never);

    const res = await svc.getEarnings('u1');

    expect(res.bySource).toEqual({ gifts: 100, treasure: 30, pk: 40 });
    expect(res.totalEarned).toBe(170);
    expect(res.settlementReady).toBe(100);
    // Gifts are read from giftTransaction now, so the ledger is consulted once,
    // for the GOLD treasure/pk rewards only.
    expect(repo.sumByReason).toHaveBeenCalledTimes(1);
    expect(repo.sumByReason).toHaveBeenNthCalledWith(
      1,
      'u1',
      [WalletTxnReason.TREASURE_BOX, WalletTxnReason.PK_REWARD],
      WalletCurrency.GOLD,
    );
    expect(prisma.giftTransaction.aggregate).toHaveBeenCalled();
  });

  it('getRewards maps ledger rows to RewardDto (paginated)', async () => {
    const repo = repoMock();
    repo.listByReasons.mockResolvedValue([
      [
        {
          id: 'r1',
          reason: WalletTxnReason.PK_REWARD,
          currency: WalletCurrency.GOLD,
          type: WalletEntryType.CREDIT,
          amount: 100n,
          referenceType: 'video_room_pk_reward',
          referenceId: 'ref1',
          createdAt: new Date('2026-07-23'),
        },
      ],
      1,
    ]);
    const wallet = { getBalance: jest.fn() };
    const prisma = {
      giftTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { creatorEarnings: 100n } }),
      },
    };
    const svc = new WalletReadService(repo as never, wallet as never, prisma as never);

    const res = await svc.getRewards('u1', 1, 20);

    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({
      id: 'r1',
      reason: 'PK_REWARD',
      amount: 100,
      source: 'video_room_pk_reward',
    });
  });

  it('getHistory maps filtered ledger rows to RewardDto with correct pagination skip', async () => {
    const repo = repoMock();
    repo.listHistory.mockResolvedValue([
      [
        {
          id: 'h1',
          reason: WalletTxnReason.GIFT_SEND,
          currency: WalletCurrency.GOLD,
          type: WalletEntryType.DEBIT,
          amount: 50n,
          referenceType: 'gift',
          referenceId: 'g1',
          createdAt: new Date('2026-07-23'),
        },
      ],
      1,
    ]);
    const wallet = { getBalance: jest.fn() };
    const prisma = {
      giftTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { creatorEarnings: 100n } }),
      },
    };
    const svc = new WalletReadService(repo as never, wallet as never, prisma as never);

    const res = await svc.getHistory('u1', { currency: WalletCurrency.GOLD }, 2, 10);

    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({ id: 'h1', reason: 'GIFT_SEND', amount: 50 });
    expect(repo.listHistory).toHaveBeenCalledWith('u1', { currency: WalletCurrency.GOLD }, 10, 10);
  });
});
