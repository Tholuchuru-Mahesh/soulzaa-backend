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
    repo.sumByReason
      .mockResolvedValueOnce([{ reason: WalletTxnReason.GIFT_RECEIVE, total: 100n }])
      .mockResolvedValueOnce([
        { reason: WalletTxnReason.TREASURE_BOX, total: 30n },
        { reason: WalletTxnReason.PK_REWARD, total: 40n },
      ]);
    const wallet = {
      getBalance: jest.fn().mockResolvedValue({ gold: 500, free: 0, earnings: 100 }),
    };
    const svc = new WalletReadService(repo as never, wallet as never);

    const res = await svc.getEarnings('u1');

    expect(res.bySource).toEqual({ gifts: 100, treasure: 30, pk: 40 });
    expect(res.totalEarned).toBe(170);
    expect(res.settlementReady).toBe(100);
    expect(repo.sumByReason).toHaveBeenNthCalledWith(
      1,
      'u1',
      [WalletTxnReason.GIFT_RECEIVE],
      WalletCurrency.EARNINGS,
    );
    expect(repo.sumByReason).toHaveBeenNthCalledWith(
      2,
      'u1',
      [WalletTxnReason.TREASURE_BOX, WalletTxnReason.PK_REWARD],
      WalletCurrency.GOLD,
    );
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
    const svc = new WalletReadService(repo as never, wallet as never);

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
    const svc = new WalletReadService(repo as never, wallet as never);

    const res = await svc.getHistory('u1', { currency: WalletCurrency.GOLD }, 2, 10);

    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({ id: 'h1', reason: 'GIFT_SEND', amount: 50 });
    expect(repo.listHistory).toHaveBeenCalledWith('u1', { currency: WalletCurrency.GOLD }, 10, 10);
  });
});
