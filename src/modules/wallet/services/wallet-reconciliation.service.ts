// src/modules/wallet/services/wallet-reconciliation.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WalletCurrency } from '@prisma/client';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { LockService } from 'src/infra/redis/lock.service';
import {
  WALLET_JOBS,
  WALLET_RECONCILE_BATCH_SIZE,
  WALLET_RECONCILE_LOCK_KEY,
} from '../constants/wallet.constants';
import { WalletMetrics } from '../metrics/wallet.metrics';
import { WalletRepository } from '../repositories/wallet.repository';

export interface CurrencyDrift {
  currency: WalletCurrency;
  ledgerComputed: number;
  balanceColumn: number;
  drift: number;
}
export interface ReconciliationReport {
  userId: string;
  perCurrency: CurrencyDrift[];
  strandedSettlements: string[];
}

const COLUMN: Record<
  WalletCurrency,
  'goldBalance' | 'gameBalance' | 'diamondBalance' | 'freeBalance' | 'earningsBalance'
> = {
  GOLD: 'goldBalance',
  DIAMOND: 'diamondBalance',
  GAME: 'gameBalance',
  FREE: 'freeBalance',
  EARNINGS: 'earningsBalance',
};

/**
 * Ledger-integrity reconciliation (VR-14). Recomputes expected balance per
 * currency from the immutable ledger and compares it to the balance column.
 * It DETECTS and reports drift; it NEVER writes a balance (balances change only
 * through WALLET_SERVICE). Registered on the existing `wallet-processing` queue.
 *
 * The daily cron tick (no `userId`) runs a cursor-paginated, single-flighted
 * scan over every wallet, reconciling each one (read-only) and reporting
 * scanned/drifted counts. The on-demand admin path (`userId` present)
 * reconciles just that user.
 *
 * `strandedSettlements` is intentionally empty: re-driving orphaned async
 * settlements is owned by the video-rooms module's own recovery services, which
 * the wallet module must not import (dependency-boundary rule).
 */
@Injectable()
export class WalletReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(WalletReconciliationService.name);

  constructor(
    private readonly repo: WalletRepository,
    private readonly metrics: WalletMetrics,
    private readonly registry: QueueJobRegistry,
    private readonly locks: LockService,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      QUEUE_NAMES.WALLET_PROCESSING,
      WALLET_JOBS.RECONCILE_SWEEP,
      (data: unknown, _job: Job) => this.handleSweep(data as { userId?: string }),
    );
  }

  /** Cron entry: fleet-wide, single-flighted by a distributed lock. */
  private async handleSweep(data: { userId?: string }): Promise<unknown> {
    return this.locks.withLock(WALLET_RECONCILE_LOCK_KEY, async () => {
      if (data.userId) return this.reconcileUser(data.userId);
      // Fleet-wide: cursor-scan every wallet in batches, reconcile each (read-only).
      let cursor: string | null = null;
      let scanned = 0;
      let drifted = 0;
      for (;;) {
        const ids = await this.repo.listUserIdsAfter(cursor, WALLET_RECONCILE_BATCH_SIZE);
        if (ids.length === 0) break;
        for (const userId of ids) {
          const report = await this.reconcileUser(userId);
          scanned += 1;
          if (report.perCurrency.some((c) => c.drift !== 0)) drifted += 1;
        }
        cursor = ids[ids.length - 1];
        if (ids.length < WALLET_RECONCILE_BATCH_SIZE) break;
      }
      this.logger.log(
        `wallet reconciliation sweep complete: scanned=${scanned} drifted=${drifted}`,
      );
      return { ok: true, scanned, drifted };
    });
  }

  /** Reconcile one user. Returns a drift report; writes nothing. */
  async reconcileUser(userId: string): Promise<ReconciliationReport> {
    const [sums, wallet] = await Promise.all([
      this.repo.aggregateSignedByCurrency(userId),
      this.repo.getWallet(userId),
    ]);
    const perCurrency: CurrencyDrift[] = [];
    for (const s of sums) {
      const ledgerComputed = Number(s.credited - s.debited);
      const balanceColumn = Number(wallet?.[COLUMN[s.currency]] ?? 0n);
      const drift = ledgerComputed - balanceColumn;
      if (drift !== 0) {
        this.metrics.recordReconciliationDrift(s.currency);
        this.logger.warn(
          `wallet drift user=${userId} currency=${s.currency} ledger=${ledgerComputed} column=${balanceColumn} drift=${drift}`,
        );
      }
      perCurrency.push({ currency: s.currency, ledgerComputed, balanceColumn, drift });
    }
    return { userId, perCurrency, strandedSettlements: [] };
  }
}
