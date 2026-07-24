import { BadRequestException } from '@nestjs/common';
import { Wallet, WalletCurrency, WalletStatus } from '@prisma/client';
import { WalletValidationService } from './wallet-validation.service';

/** Minimal Wallet fixture — only the balance fields under test matter. */
const wallet = (over: Partial<Wallet>): Wallet =>
  ({
    id: 'w1',
    status: WalletStatus.ACTIVE,
    goldBalance: 0n,
    freeBalance: 0n,
    earningsBalance: 0n,
    availableBalance: 0n,
    reservedBalance: 0n,
    pendingBalance: 0n,
    lockedBalance: 0n,
    ...over,
  }) as Wallet;

describe('WalletValidationService.validateSufficientBalance (currency-scoped)', () => {
  // Pure method — irrelevant deps stubbed.
  const svc = new WalletValidationService({} as any, {} as any);

  it('rejects a GOLD debit when only FREE coins are available', () => {
    const w = wallet({ goldBalance: 0n, freeBalance: 100n, availableBalance: 100n });
    expect(() => svc.validateSufficientBalance(w, 50n, WalletCurrency.GOLD)).toThrow(
      BadRequestException,
    );
  });

  it('allows a GOLD debit when goldBalance is sufficient', () => {
    const w = wallet({ goldBalance: 100n, freeBalance: 0n, availableBalance: 100n });
    expect(() => svc.validateSufficientBalance(w, 50n, WalletCurrency.GOLD)).not.toThrow();
  });

  it('validates FREE and EARNINGS against their own sub-balances', () => {
    const w = wallet({ freeBalance: 10n, earningsBalance: 5n, availableBalance: 15n });
    expect(() => svc.validateSufficientBalance(w, 8n, WalletCurrency.FREE)).not.toThrow();
    expect(() => svc.validateSufficientBalance(w, 8n, WalletCurrency.EARNINGS)).toThrow(
      BadRequestException,
    );
  });

  it('checks the aggregate availableBalance when no currency is supplied (legacy callers unchanged)', () => {
    // Reservation/transfer omit currency and operate on the aggregate — must not regress.
    const w = wallet({ goldBalance: 0n, freeBalance: 100n, availableBalance: 100n });
    expect(() => svc.validateSufficientBalance(w, 50n)).not.toThrow();
  });
});
