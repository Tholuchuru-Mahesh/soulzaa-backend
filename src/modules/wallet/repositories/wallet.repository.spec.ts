import { WalletCurrency, WalletEntryType } from '@prisma/client';
import { WalletRepository } from './wallet.repository';

describe('WalletRepository.aggregateSignedByCurrency', () => {
  it('accumulates credited/debited per currency from grouped rows', async () => {
    const groupBy = jest.fn().mockResolvedValue([
      { currency: WalletCurrency.GOLD, type: WalletEntryType.CREDIT, _sum: { amount: 100n } },
      { currency: WalletCurrency.GOLD, type: WalletEntryType.DEBIT, _sum: { amount: 30n } },
      { currency: WalletCurrency.EARNINGS, type: WalletEntryType.CREDIT, _sum: { amount: 50n } },
    ]);
    const repo = new WalletRepository({ walletTransaction: { groupBy } } as never);

    const out = await repo.aggregateSignedByCurrency('u1');

    const gold = out.find((r) => r.currency === WalletCurrency.GOLD)!;
    expect(gold.credited).toBe(100n);
    expect(gold.debited).toBe(30n);
    const earnings = out.find((r) => r.currency === WalletCurrency.EARNINGS)!;
    expect(earnings.credited).toBe(50n);
    expect(earnings.debited).toBe(0n);
  });
});

describe('WalletRepository.listUserIdsAfter', () => {
  it('returns userIds ascending, using a cursor after the first page', async () => {
    const findMany = jest.fn().mockResolvedValue([{ userId: 'b' }, { userId: 'c' }]);
    const repo = new WalletRepository({ wallet: { findMany } } as never);

    const ids = await repo.listUserIdsAfter('a', 2);

    expect(ids).toEqual(['b', 'c']);
    expect(findMany).toHaveBeenCalledWith({
      cursor: { userId: 'a' },
      skip: 1,
      take: 2,
      orderBy: { userId: 'asc' },
      select: { userId: true },
    });
  });

  it('omits cursor/skip on the first page (null cursor)', async () => {
    const findMany = jest.fn().mockResolvedValue([{ userId: 'a' }]);
    const repo = new WalletRepository({ wallet: { findMany } } as never);

    await repo.listUserIdsAfter(null, 100);

    expect(findMany).toHaveBeenCalledWith({
      take: 100,
      orderBy: { userId: 'asc' },
      select: { userId: true },
    });
  });
});
