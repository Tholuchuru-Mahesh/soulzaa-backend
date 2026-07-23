// src/modules/wallet/metrics/wallet.metrics.ts
import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from 'src/infra/observability/metrics.service';

/**
 * Wallet Prometheus metrics (VR-14), registered on the shared registry so they
 * surface at /metrics. Mirrors the MonitoringMetrics pattern. Volume + duration
 * give TPS and latency; failed + drift give the health signals.
 */
@Injectable()
export class WalletMetrics {
  private readonly transactions: Counter<'reason' | 'type' | 'currency'>;
  private readonly duration: Histogram<'reason' | 'type'>;
  private readonly failed: Counter<'reason'>;
  private readonly drift: Counter<'currency'>;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];
    this.transactions = new Counter({
      name: 'wallet_transactions_total',
      help: 'Total wallet movements observed',
      labelNames: ['reason', 'type', 'currency'] as const,
      registers,
    });
    this.duration = new Histogram({
      name: 'wallet_movement_duration_seconds',
      help: 'Observed wallet movement handling duration in seconds',
      labelNames: ['reason', 'type'] as const,
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.3, 1],
      registers,
    });
    this.failed = new Counter({
      name: 'wallet_transaction_failed_total',
      help: 'Total wallet operations that failed (application layer)',
      labelNames: ['reason'] as const,
      registers,
    });
    this.drift = new Counter({
      name: 'wallet_reconciliation_drift_total',
      help: 'Total ledger-vs-balance drifts detected by reconciliation',
      labelNames: ['currency'] as const,
      registers,
    });
  }

  recordMovement(reason: string, type: string, currency: string, seconds: number): void {
    this.transactions.inc({ reason, type, currency });
    this.duration.observe({ reason, type }, seconds);
  }

  recordFailed(reason: string): void {
    this.failed.inc({ reason });
  }

  recordReconciliationDrift(currency: string): void {
    this.drift.inc({ currency });
  }
}
