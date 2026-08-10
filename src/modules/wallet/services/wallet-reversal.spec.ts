import { WalletCurrency, WalletStatus, WalletTxnReason } from '@prisma/client';
import { WalletTransactionService } from './wallet-transaction.service';

/**
 * A refund claw-back has to work in exactly the cases a normal debit refuses:
 * the coins are already spent, or the wallet has since been suspended. Anything
 * that blocks here leaves refunded coins in circulation permanently.
 */
describe('WalletTransactionService.reverseWallet', () => {
  const WALLET = {
    id: 'wallet-1',
    userId: 'user-1',
    status: WalletStatus.ACTIVE,
    availableBalance: 10n,
    goldBalance: 10n,
    gameBalance: 0n,
    diamondBalance: 0n,
  };

  const build = (wallet: any = WALLET) => {
    const created: any[] = [];
    const tx: any = {
      $queryRaw: jest.fn(),
      wallet: {
        findUnique: jest.fn().mockResolvedValue(wallet),
        update: jest
          .fn()
          .mockResolvedValue({ ...wallet, availableBalance: wallet.availableBalance - 250n }),
      },
      walletTransaction: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          created.push(data);
          return { id: 'tx-1', ...data, createdAt: new Date() };
        }),
      },
      ledgerEntry: { create: jest.fn() },
    };
    const prisma: any = {
      walletTransaction: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((fn: any) => fn(tx)),
    };
    const service = new WalletTransactionService(
      prisma,
      { getOrCreateWallet: jest.fn().mockResolvedValue(wallet) } as any,
      { appendLedgerEntry: jest.fn() } as any,
      {
        validateEconomyStatus: jest.fn().mockResolvedValue(undefined),
        validatePositiveAmount: jest.fn(),
        validateWalletActive: jest.fn(() => {
          throw new Error('validateWalletActive must not be called by reverseWallet');
        }),
        validateSufficientBalance: jest.fn(() => {
          throw new Error('validateSufficientBalance must not be called by reverseWallet');
        }),
      } as any,
      { logAudit: jest.fn() } as any,
    );
    return { service, tx, prisma };
  };

  const dto = {
    userId: 'user-1',
    amount: 250,
    currency: WalletCurrency.GOLD,
    reason: WalletTxnReason.PURCHASE_REVERSAL,
    idempotencyKey: 'REVERSAL_GPA.1',
  } as any;

  it('drives the balance negative when the coins are already spent', async () => {
    const { service } = build();

    const result = await service.reverseWallet(dto);

    expect((result as any).balanceAfter).toBe('-240');
    expect((result as any).type).toBe('DEBIT');
  });

  it('reverses against a suspended wallet', async () => {
    const { service } = build({ ...WALLET, status: WalletStatus.SUSPENDED });

    await expect(service.reverseWallet(dto)).resolves.toBeDefined();
  });

  it('is idempotent on a repeated key', async () => {
    const { service } = build();
    (service as any).prisma.walletTransaction.findUnique.mockResolvedValue({
      id: 'tx-existing',
      idempotencyKey: 'REVERSAL_GPA.1',
      amount: 250n,
      status: 'COMPLETED',
      createdAt: new Date(),
    });

    const result = await service.reverseWallet(dto);

    expect(result.transactionId).toBe('tx-existing');
  });

  it('rejects any reason other than PURCHASE_REVERSAL before any money moves', async () => {
    const { service, prisma } = build();
    const wrongReasonDto = { ...dto, reason: WalletTxnReason.ADMIN_DEBIT };

    await expect(service.reverseWallet(wrongReasonDto)).rejects.toThrow(
      'reverseWallet is restricted to PURCHASE_REVERSAL',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows PURCHASE_REVERSAL through the reason guard', async () => {
    const { service, prisma } = build();

    await expect(service.reverseWallet(dto)).resolves.toBeDefined();
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
