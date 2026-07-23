import { WALLET_SOCKET_EVENTS, WALLET_JOBS, WALLET_COALESCE_WINDOW_MS } from './wallet.constants';

describe('wallet Phase-14 constants', () => {
  it('exposes the four personal wallet socket event names', () => {
    expect(WALLET_SOCKET_EVENTS).toEqual({
      WALLET_UPDATED: 'walletUpdated',
      BALANCE_CHANGED: 'balanceChanged',
      TRANSACTION_CREATED: 'transactionCreated',
      TRANSACTION_COMPLETED: 'transactionCompleted',
    });
  });

  it('exposes the reconciliation job name', () => {
    expect(WALLET_JOBS.RECONCILE_SWEEP).toBe('wallet.reconcile.sweep');
  });

  it('keeps the coalescing window within the agreed 50–100ms band', () => {
    expect(WALLET_COALESCE_WINDOW_MS).toBeGreaterThanOrEqual(50);
    expect(WALLET_COALESCE_WINDOW_MS).toBeLessThanOrEqual(100);
  });
});
