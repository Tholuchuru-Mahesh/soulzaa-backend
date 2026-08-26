import { WalletCurrency, WalletTxnReason } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { WALLET_EVENTS } from 'src/modules/wallet/events/wallet.events';
import { WealthExpLedgerService } from '../services/wealth-exp-ledger.service';
import { WealthExpListener } from './wealth-exp.listener';

describe('WealthExpListener', () => {
  let bus: { subscribe: jest.Mock; publish: jest.Mock };
  let ledger: { award: jest.Mock };
  let listener: WealthExpListener;
  let handler: (e: unknown) => void;

  beforeEach(() => {
    bus = {
      subscribe: jest.fn((_name: string, fn: (e: unknown) => void) => {
        handler = fn;
      }),
      publish: jest.fn(),
    };
    ledger = {
      award: jest.fn().mockResolvedValue({ currentExp: 0, currentLevel: 0, leveledUp: false }),
    };
    listener = new WealthExpListener(
      bus as unknown as IEventBus,
      ledger as unknown as WealthExpLedgerService,
    );
    listener.onModuleInit();
  });

  it('subscribes to WALLET_EVENTS.CREDITED', () => {
    expect(bus.subscribe).toHaveBeenCalledWith(WALLET_EVENTS.CREDITED, expect.any(Function));
  });

  it('awards EXP equal to the full credited amount (paid + bonus already merged) for a verified Gold Coin purchase', () => {
    handler({
      payload: {
        userId: 'u1',
        transactionId: 'tx-1',
        currency: WalletCurrency.GOLD,
        amount: 12_000,
        reason: WalletTxnReason.RECHARGE,
        referenceType: 'purchase_order',
        referenceId: 'order-1',
      },
    });

    expect(ledger.award).toHaveBeenCalledWith({
      userId: 'u1',
      amount: 12_000,
      sourceRef: 'order-1',
      idempotencyKey: 'wealth-exp:tx-1',
    });
  });

  it('falls back to the wallet transaction id as sourceRef when no order reference is present', () => {
    handler({
      payload: {
        userId: 'u1',
        transactionId: 'tx-2',
        currency: WalletCurrency.GOLD,
        amount: 500,
        reason: WalletTxnReason.RECHARGE,
        referenceType: null,
        referenceId: null,
      },
    });

    expect(ledger.award).toHaveBeenCalledWith(expect.objectContaining({ sourceRef: 'tx-2' }));
  });

  it.each([
    [
      'a non-RECHARGE reason',
      { reason: WalletTxnReason.ADMIN_CREDIT, currency: WalletCurrency.GOLD, amount: 100 },
    ],
    [
      'a non-GOLD currency',
      { reason: WalletTxnReason.RECHARGE, currency: WalletCurrency.DIAMOND, amount: 100 },
    ],
    [
      'a zero amount',
      { reason: WalletTxnReason.RECHARGE, currency: WalletCurrency.GOLD, amount: 0 },
    ],
    [
      'a negative amount',
      { reason: WalletTxnReason.RECHARGE, currency: WalletCurrency.GOLD, amount: -1 },
    ],
  ])('ignores %s', (_label, partial) => {
    handler({
      payload: {
        userId: 'u1',
        transactionId: 'tx-3',
        referenceType: 'purchase_order',
        referenceId: 'order-1',
        ...partial,
      },
    });

    expect(ledger.award).not.toHaveBeenCalled();
  });

  it('does not throw if the ledger award rejects — best-effort, never blocks the recharge', async () => {
    ledger.award.mockRejectedValue(new Error('lock timeout'));

    expect(() =>
      handler({
        payload: {
          userId: 'u1',
          transactionId: 'tx-4',
          currency: WalletCurrency.GOLD,
          amount: 100,
          reason: WalletTxnReason.RECHARGE,
          referenceType: 'purchase_order',
          referenceId: 'order-1',
        },
      }),
    ).not.toThrow();

    // Let the rejected promise's .catch() run before the test ends.
    await new Promise((r) => setImmediate(r));
  });
});
