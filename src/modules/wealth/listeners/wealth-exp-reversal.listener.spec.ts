import { WalletCurrency, WalletTxnReason } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { WALLET_EVENTS } from 'src/modules/wallet/events/wallet.events';
import { WealthExpLedgerService } from '../services/wealth-exp-ledger.service';
import { WealthExpReversalListener } from './wealth-exp-reversal.listener';

describe('WealthExpReversalListener', () => {
  let bus: { subscribe: jest.Mock; publish: jest.Mock };
  let ledger: { reverse: jest.Mock };
  let listener: WealthExpReversalListener;
  let handler: (e: unknown) => void;

  beforeEach(() => {
    bus = {
      subscribe: jest.fn((_name: string, fn: (e: unknown) => void) => {
        handler = fn;
      }),
      publish: jest.fn(),
    };
    ledger = { reverse: jest.fn().mockResolvedValue(undefined) };
    listener = new WealthExpReversalListener(
      bus as unknown as IEventBus,
      ledger as unknown as WealthExpLedgerService,
    );
    listener.onModuleInit();
  });

  it('subscribes to WALLET_EVENTS.DEBITED', () => {
    expect(bus.subscribe).toHaveBeenCalledWith(WALLET_EVENTS.DEBITED, expect.any(Function));
  });

  it('reverses EXP for a PURCHASE_REVERSAL debit, keyed on the reversal wallet transaction id', () => {
    handler({
      payload: {
        userId: 'u1',
        transactionId: 'tx-reversal-1',
        currency: WalletCurrency.GOLD,
        amount: 10_000,
        reason: WalletTxnReason.PURCHASE_REVERSAL,
        referenceType: 'purchase_order',
        referenceId: 'order-1',
      },
    });

    expect(ledger.reverse).toHaveBeenCalledWith({
      userId: 'u1',
      sourceRef: 'order-1',
      amount: 10_000,
      idempotencyKey: 'wealth-exp-reversal:tx-reversal-1',
    });
  });

  it.each([
    [
      'a non-PURCHASE_REVERSAL reason (e.g. an ordinary debit)',
      { reason: WalletTxnReason.GIFT_SEND, currency: WalletCurrency.GOLD, amount: 100 },
    ],
    [
      'a non-GOLD currency',
      { reason: WalletTxnReason.PURCHASE_REVERSAL, currency: WalletCurrency.DIAMOND, amount: 100 },
    ],
    [
      'a zero amount',
      { reason: WalletTxnReason.PURCHASE_REVERSAL, currency: WalletCurrency.GOLD, amount: 0 },
    ],
  ])('ignores %s', (_label, partial) => {
    handler({
      payload: {
        userId: 'u1',
        transactionId: 'tx-x',
        referenceType: 'purchase_order',
        referenceId: 'order-1',
        ...partial,
      },
    });

    expect(ledger.reverse).not.toHaveBeenCalled();
  });
});
