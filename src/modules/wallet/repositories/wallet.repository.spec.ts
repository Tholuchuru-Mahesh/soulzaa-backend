import { WalletCurrency, WalletEntryType } from '@prisma/client';
import { WalletRepository } from './wallet.repository';

describe('WalletRepository.aggregateSignedByCurrency', () => {
  /** Groups the double-entry ledger for a wallet the user actually owns. */
  const prismaWith = (rows: unknown[], wallet: unknown = { id: 'w1' }) => ({
    wallet: { findUnique: jest.fn().mockResolvedValue(wallet) },
    ledgerEntry: { groupBy: jest.fn().mockResolvedValue(rows) },
  });

  it('accumulates credited/debited per currency from grouped rows', async () => {
    const prisma = prismaWith([
      { currency: WalletCurrency.GOLD, type: WalletEntryType.CREDIT, _sum: { amount: 100n } },
      { currency: WalletCurrency.GOLD, type: WalletEntryType.DEBIT, _sum: { amount: 30n } },
      { currency: WalletCurrency.EARNINGS, type: WalletEntryType.CREDIT, _sum: { amount: 50n } },
    ]);
    const repo = new WalletRepository(prisma as never);

    const out = await repo.aggregateSignedByCurrency('u1');

    const gold = out.find((r) => r.currency === WalletCurrency.GOLD)!;
    expect(gold.credited).toBe(100n);
    expect(gold.debited).toBe(30n);
    const earnings = out.find((r) => r.currency === WalletCurrency.EARNINGS)!;
    expect(earnings.credited).toBe(50n);
    expect(earnings.debited).toBe(0n);
  });

  it('scopes the aggregate to the caller wallet', async () => {
    const prisma = prismaWith([]);
    const repo = new WalletRepository(prisma as never);

    await repo.aggregateSignedByCurrency('u1');

    expect(prisma.wallet.findUnique).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.ledgerEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId: 'w1' } }),
    );
  });

  it('returns nothing for a user with no wallet, without touching the ledger', async () => {
    const prisma = prismaWith([], null);
    const repo = new WalletRepository(prisma as never);

    await expect(repo.aggregateSignedByCurrency('ghost')).resolves.toEqual([]);
    expect(prisma.ledgerEntry.groupBy).not.toHaveBeenCalled();
  });

  it('treats a null _sum as zero rather than propagating null into the totals', async () => {
    const prisma = prismaWith([
      { currency: WalletCurrency.GOLD, type: WalletEntryType.CREDIT, _sum: { amount: null } },
    ]);
    const repo = new WalletRepository(prisma as never);

    const [gold] = await repo.aggregateSignedByCurrency('u1');
    expect(gold.credited).toBe(0n);
    expect(gold.debited).toBe(0n);
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
