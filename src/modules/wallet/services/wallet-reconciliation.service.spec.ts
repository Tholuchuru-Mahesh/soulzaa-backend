import { WalletCurrency } from '@prisma/client';
import { WalletReconciliationService } from './wallet-reconciliation.service';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import {
  WALLET_JOBS,
  WALLET_RECONCILE_LOCK_KEY,
  WALLET_RECONCILE_BATCH_SIZE,
} from '../constants/wallet.constants';

function deps() {
  return {
    repo: {
      aggregateSignedByCurrency: jest.fn(),
      getWallet: jest.fn(),
      applyMovement: jest.fn(),
      listUserIdsAfter: jest.fn().mockResolvedValue([]),
    },
    metrics: {
      recordReconciliationDrift: jest.fn(),
      recordMovement: jest.fn(),
      recordFailed: jest.fn(),
    },
    registry: { register: jest.fn() },
    locks: { withLock: jest.fn(async (_k: string, fn: () => unknown) => fn()) },
  };
}

describe('WalletReconciliationService', () => {
  it('reports drift when ledger sum != balance column, and NEVER writes a balance', async () => {
    const d = deps();
    d.repo.aggregateSignedByCurrency.mockResolvedValue([
      { currency: WalletCurrency.GOLD, credited: 100n, debited: 30n }, // ledger => 70
    ]);
    d.repo.getWallet.mockResolvedValue({ goldBalance: 65n, gameBalance: 0n, diamondBalance: 0n }); // column => 65
    const svc = new WalletReconciliationService(
      d.repo as never,
      d.metrics as never,
      d.registry as never,
      d.locks as never,
    );

    const report = await svc.reconcileUser('u1');

    const gold = report.perCurrency.find((c) => c.currency === WalletCurrency.GOLD)!;
    expect(gold.ledgerComputed).toBe(70);
    expect(gold.balanceColumn).toBe(65);
    expect(gold.drift).toBe(5);
    expect(d.metrics.recordReconciliationDrift).toHaveBeenCalledWith('GOLD');
    // Safety invariant: reconciliation never writes a balance.
    expect(d.repo.applyMovement).not.toHaveBeenCalled();
  });

  it('reports zero drift when ledger matches the column', async () => {
    const d = deps();
    d.repo.aggregateSignedByCurrency.mockResolvedValue([
      { currency: WalletCurrency.DIAMOND, credited: 50n, debited: 0n },
    ]);
    d.repo.getWallet.mockResolvedValue({ goldBalance: 0n, gameBalance: 0n, diamondBalance: 50n });
    const svc = new WalletReconciliationService(
      d.repo as never,
      d.metrics as never,
      d.registry as never,
      d.locks as never,
    );

    const report = await svc.reconcileUser('u1');
    expect(report.perCurrency.find((c) => c.currency === WalletCurrency.DIAMOND)!.drift).toBe(0);
    expect(d.metrics.recordReconciliationDrift).not.toHaveBeenCalled();
  });

  it('registers the reconcile-sweep handler on the wallet-processing queue', () => {
    const d = deps();
    const svc = new WalletReconciliationService(
      d.repo as never,
      d.metrics as never,
      d.registry as never,
      d.locks as never,
    );
    svc.onModuleInit();
    expect(d.registry.register).toHaveBeenCalledWith(
      QUEUE_NAMES.WALLET_PROCESSING,
      WALLET_JOBS.RECONCILE_SWEEP,
      expect.any(Function),
    );
  });

  it('the registered handler reconciles a specific user under the distributed lock, else no-ops', async () => {
    const d = deps();
    d.repo.aggregateSignedByCurrency.mockResolvedValue([]);
    d.repo.getWallet.mockResolvedValue(null);
    const svc = new WalletReconciliationService(
      d.repo as never,
      d.metrics as never,
      d.registry as never,
      d.locks as never,
    );
    svc.onModuleInit();
    const handler = d.registry.register.mock.calls[0][2] as (
      data: unknown,
      job: unknown,
    ) => Promise<unknown>;

    const perUser = await handler({ userId: 'u1' }, {} as never);
    expect(d.locks.withLock).toHaveBeenCalledWith(WALLET_RECONCILE_LOCK_KEY, expect.any(Function));
    expect(perUser).toMatchObject({ userId: 'u1', perCurrency: [], strandedSettlements: [] });

    const noop = await handler({}, {} as never);
    expect(noop).toEqual({ ok: true, scanned: 0, drifted: 0 });
  });

  it('the sweep scans all wallets in cursor batches and reports scanned/drifted counts', async () => {
    const d = deps();
    // two pages then empty; page size in the test is small via the batch constant
    d.repo.listUserIdsAfter.mockResolvedValueOnce(['u1', 'u2']).mockResolvedValueOnce([]);
    // u1 drifts (gold ledger 70 vs column 65), u2 clean
    d.repo.aggregateSignedByCurrency.mockImplementation(async (userId: string) =>
      userId === 'u1'
        ? [{ currency: WalletCurrency.GOLD, credited: 100n, debited: 30n }]
        : [{ currency: WalletCurrency.GOLD, credited: 50n, debited: 0n }],
    );
    d.repo.getWallet.mockImplementation(async (userId: string) =>
      userId === 'u1'
        ? { goldBalance: 65n, gameBalance: 0n, diamondBalance: 0n }
        : { goldBalance: 50n, gameBalance: 0n, diamondBalance: 0n },
    );
    const svc = new WalletReconciliationService(
      d.repo as never,
      d.metrics as never,
      d.registry as never,
      d.locks as never,
    );
    svc.onModuleInit();
    const handler = d.registry.register.mock.calls[0][2] as (
      data: unknown,
      job: unknown,
    ) => Promise<unknown>;

    const result = (await handler({}, {} as never)) as {
      ok: boolean;
      scanned: number;
      drifted: number;
    };

    expect(d.locks.withLock).toHaveBeenCalledWith(WALLET_RECONCILE_LOCK_KEY, expect.any(Function));
    expect(result).toEqual({ ok: true, scanned: 2, drifted: 1 });
    expect(d.metrics.recordReconciliationDrift).toHaveBeenCalledWith('GOLD'); // from u1 only
  });

  it('the sweep continues past a full-size page and terminates on the next (cursor advances)', async () => {
    const d = deps();
    const firstPage = Array.from({ length: WALLET_RECONCILE_BATCH_SIZE }, (_, i) => `u${i}`);
    d.repo.listUserIdsAfter
      .mockResolvedValueOnce(firstPage) // full page → loop continues
      .mockResolvedValueOnce(['last']); // short page → processed, then break
    d.repo.aggregateSignedByCurrency.mockResolvedValue([]); // all clean
    d.repo.getWallet.mockResolvedValue({ goldBalance: 0n, gameBalance: 0n, diamondBalance: 0n });
    const svc = new WalletReconciliationService(
      d.repo as never,
      d.metrics as never,
      d.registry as never,
      d.locks as never,
    );
    svc.onModuleInit();
    const handler = d.registry.register.mock.calls[0][2] as (
      data: unknown,
      job: unknown,
    ) => Promise<unknown>;

    const result = (await handler({}, {} as never)) as {
      ok: boolean;
      scanned: number;
      drifted: number;
    };

    expect(d.repo.listUserIdsAfter).toHaveBeenCalledTimes(2);
    expect(d.repo.listUserIdsAfter).toHaveBeenNthCalledWith(1, null, WALLET_RECONCILE_BATCH_SIZE);
    expect(d.repo.listUserIdsAfter).toHaveBeenNthCalledWith(
      2,
      firstPage[firstPage.length - 1],
      WALLET_RECONCILE_BATCH_SIZE,
    );
    expect(result).toEqual({ ok: true, scanned: WALLET_RECONCILE_BATCH_SIZE + 1, drifted: 0 });
  });
});
