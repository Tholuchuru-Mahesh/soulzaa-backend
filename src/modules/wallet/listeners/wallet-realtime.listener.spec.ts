import { WalletRealtimeListener } from './wallet-realtime.listener';
import { WALLET_SOCKET_EVENTS, WALLET_COALESCE_WINDOW_MS } from '../constants/wallet.constants';
import { WALLET_EVENTS } from '../events/wallet.events';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const bus = {
    subscribe: (name: string, h: (e: unknown) => void) => {
      handlers[name] = h;
      return () => undefined;
    },
    publish: jest.fn(),
  };
  const sockets = { emitToUserEverywhere: jest.fn(), emitToNamespaceRoom: jest.fn() };
  const wallet = { getBalance: jest.fn().mockResolvedValue({ gold: 90, free: 0, earnings: 5 }) };
  const metrics = {
    recordMovement: jest.fn(),
    recordFailed: jest.fn(),
    recordReconciliationDrift: jest.fn(),
  };
  return { handlers, bus, sockets, wallet, metrics };
}

const debited = (over: Partial<Record<string, unknown>> = {}) => ({
  payload: {
    userId: 'u1',
    transactionId: 't1',
    currency: 'GOLD',
    amount: 10,
    balanceAfter: 90,
    reason: 'GIFT_SEND',
    referenceType: 'gift',
    referenceId: null,
    ...over,
  },
});

describe('WalletRealtimeListener', () => {
  it('emits transactionCreated + transactionCompleted immediately (not coalesced)', async () => {
    const d = makeDeps();
    const l = new WalletRealtimeListener(
      d.bus as never,
      d.sockets as never,
      d.wallet as never,
      d.metrics as never,
    );
    l.onModuleInit();

    await d.handlers[WALLET_EVENTS.DEBITED](debited());

    const events = d.sockets.emitToUserEverywhere.mock.calls.map((c: unknown[]) => c[1]);
    expect(events).toContain(WALLET_SOCKET_EVENTS.TRANSACTION_CREATED);
    expect(events).toContain(WALLET_SOCKET_EVENTS.TRANSACTION_COMPLETED);
    expect(d.metrics.recordMovement).toHaveBeenCalledWith(
      'GIFT_SEND',
      'DEBIT',
      'GOLD',
      expect.any(Number),
    );
  });

  it('coalesces balanceChanged/walletUpdated to one broadcast per window with the latest balance', async () => {
    const d = makeDeps();
    d.wallet.getBalance.mockResolvedValue({ gold: 70, free: 0, earnings: 5 });
    const l = new WalletRealtimeListener(
      d.bus as never,
      d.sockets as never,
      d.wallet as never,
      d.metrics as never,
    );
    l.onModuleInit();

    await d.handlers[WALLET_EVENTS.DEBITED](debited({ balanceAfter: 90 }));
    await d.handlers[WALLET_EVENTS.DEBITED](debited({ balanceAfter: 80 }));
    await d.handlers[WALLET_EVENTS.DEBITED](debited({ balanceAfter: 70 }));

    await l.flush('u1'); // force the window closed deterministically

    const balanceEvents = d.sockets.emitToUserEverywhere.mock.calls.filter(
      (c: unknown[]) => c[1] === WALLET_SOCKET_EVENTS.BALANCE_CHANGED,
    );
    expect(balanceEvents).toHaveLength(1);
    expect((balanceEvents[0][2] as { balances: { gold: number } }).balances.gold).toBe(70);
  });

  it('collapses a burst within the window to ONE real-timer flush (latest balance)', async () => {
    jest.useFakeTimers();
    try {
      const d = makeDeps();
      d.wallet.getBalance.mockResolvedValue({ gold: 70, free: 0, earnings: 5 });
      const l = new WalletRealtimeListener(
        d.bus as never,
        d.sockets as never,
        d.wallet as never,
        d.metrics as never,
      );
      l.onModuleInit();

      // Three movements inside one 75ms window — each reschedules the timer.
      await d.handlers[WALLET_EVENTS.DEBITED](debited({ balanceAfter: 90 }));
      await d.handlers[WALLET_EVENTS.DEBITED](debited({ balanceAfter: 80 }));
      await d.handlers[WALLET_EVENTS.DEBITED](debited({ balanceAfter: 70 }));

      // No balance broadcast before the window elapses.
      const before = d.sockets.emitToUserEverywhere.mock.calls.filter(
        (c: unknown[]) => c[1] === WALLET_SOCKET_EVENTS.BALANCE_CHANGED,
      );
      expect(before).toHaveLength(0);

      await jest.advanceTimersByTimeAsync(WALLET_COALESCE_WINDOW_MS);

      const balanceEvents = d.sockets.emitToUserEverywhere.mock.calls.filter(
        (c: unknown[]) => c[1] === WALLET_SOCKET_EVENTS.BALANCE_CHANGED,
      );
      expect(balanceEvents).toHaveLength(1);
      expect((balanceEvents[0][2] as { balances: { gold: number } }).balances.gold).toBe(70);
      // getBalance called once (one flush), not once per movement.
      expect(d.wallet.getBalance).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
