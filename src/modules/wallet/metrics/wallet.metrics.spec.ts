import { MetricsService } from 'src/infra/observability/metrics.service';
import { WalletMetrics } from './wallet.metrics';

describe('WalletMetrics', () => {
  let metrics: MetricsService;
  let wallet: WalletMetrics;

  beforeEach(() => {
    metrics = new MetricsService();
    wallet = new WalletMetrics(metrics);
  });

  it('registers wallet metric families on the shared registry', async () => {
    wallet.recordMovement('GIFT_SEND', 'DEBIT', 'GOLD', 0.012);
    wallet.recordFailed('INSUFFICIENT_BALANCE');
    wallet.recordReconciliationDrift('GOLD');

    const out = await metrics.registry.metrics();
    expect(out).toContain('wallet_transactions_total');
    expect(out).toContain('wallet_movement_duration_seconds');
    expect(out).toContain('wallet_transaction_failed_total');
    expect(out).toContain('wallet_reconciliation_drift_total');
  });
});
