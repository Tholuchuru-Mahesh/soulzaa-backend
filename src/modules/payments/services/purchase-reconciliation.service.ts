import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PaymentProvider, PurchaseOrderStatus } from '@prisma/client';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GooglePlayApiClient } from '../adapters/google-play-api.client';
import { CONSUME_RETRY_BATCH_SIZE, PAYMENT_JOBS } from '../constants';
import { PurchaseAuditService } from './purchase-audit.service';

/** What one sweep did, returned to the worker and logged. */
export interface ConsumeRetryReport {
  scanned: number;
  consumed: number;
  failed: number;
  skipped: number;
}

@Injectable()
export class PurchaseReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(PurchaseReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playApiClient: GooglePlayApiClient,
    private readonly auditService: PurchaseAuditService,
    private readonly registry: QueueJobRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(QUEUE_NAMES.WALLET_PROCESSING, PAYMENT_JOBS.RECONCILE_SWEEP, () =>
      this.runReconciliationSweep(),
    );
  }

  /**
   * Cron entry point for the payments sweep. Both passes run every tick and are
   * independent: a throw from the consume retry must not stop orders expiring,
   * so the expiry pass goes first and the consume pass owns its own failures
   * per-order.
   */
  async runReconciliationSweep() {
    const expiry = await this.reconcileExpiredOrders();
    const consumes = await this.retryPendingConsumes();
    return { ...expiry, consumes };
  }

  /**
   * Identifies expired purchase orders past their expiration timestamp and marks them as EXPIRED
   */
  async reconcileExpiredOrders() {
    const now = new Date();
    const expiredCount = await this.prisma.purchaseOrder.updateMany({
      where: {
        status: { in: [PurchaseOrderStatus.CREATED, PurchaseOrderStatus.PENDING_PAYMENT] },
        expiresAt: { lt: now },
      },
      data: {
        status: PurchaseOrderStatus.EXPIRED,
      },
    });

    if (expiredCount.count > 0) {
      this.logger.log(`Reconciled and marked ${expiredCount.count} purchase orders as EXPIRED`);
    }

    return { expiredCount: expiredCount.count, timestamp: now };
  }

  /**
   * Retries the Google Play consume for COMPLETED orders whose consume never
   * landed (`consumedAt IS NULL`).
   *
   * Without this, a single failed consume strands the user permanently: the
   * Flutter plugin's `completePurchase` only ACKNOWLEDGES on Android, it never
   * consumes, so the product stays owned-and-unconsumed in Play. The user can
   * never buy that tier again, and `restorePurchases()` redelivers the purchase
   * on every launch into a `PendingOrderStore.take()` that now returns null,
   * producing a permanent "could not be matched to an order" message. Nothing
   * else in the system ever retries.
   *
   * Safe to run repeatedly: the coins were already credited when the order went
   * COMPLETED, and consuming an already-consumed token is a no-op at Play. This
   * touches no balances.
   */
  async retryPendingConsumes(
    limit: number = CONSUME_RETRY_BATCH_SIZE,
  ): Promise<ConsumeRetryReport> {
    const report: ConsumeRetryReport = { scanned: 0, consumed: 0, failed: 0, skipped: 0 };

    // Without credentials every call would throw identically; bail before
    // generating one audit row per order.
    if (!this.playApiClient.isConfigured()) {
      this.logger.debug('Google Play API not configured — skipping consume retry sweep');
      return report;
    }

    const orders = await this.prisma.purchaseOrder.findMany({
      where: {
        status: PurchaseOrderStatus.COMPLETED,
        provider: PaymentProvider.GOOGLE_PLAY,
        consumedAt: null,
      },
      // Bounded: each retry is a network round-trip to Google, so an unbounded
      // batch would let a backlog stall the worker for the whole cron interval.
      // Oldest first, so a persistent failure can never starve newer orders.
      orderBy: { completedAt: 'asc' },
      take: limit,
      include: { package: true, receipts: true },
    });

    report.scanned = orders.length;

    for (const order of orders) {
      const productId = order.package?.googleProductId;
      // The purchase token is stored as PaymentReceipt.receiptData. Prefer the
      // verified receipt; an unverified leftover is not a token we ever proved
      // belongs to this order.
      const purchaseToken = order.receipts.find((r) => r.isVerified && r.receiptData)?.receiptData;

      if (!productId || !purchaseToken) {
        report.skipped += 1;
        this.logger.warn(
          `Skipping consume retry for order ${order.id}: ${
            !productId ? 'package has no googleProductId' : 'no verified receipt token'
          }`,
        );
        continue;
      }

      // One order's failure must not abort the rest of the batch.
      try {
        await this.playApiClient.consumeProductPurchase(productId, purchaseToken);
        await this.prisma.purchaseOrder.update({
          where: { id: order.id },
          data: { consumedAt: new Date() },
        });
        report.consumed += 1;
        await this.auditService.logAudit(order.id, 'CONSUME_RETRY_SUCCEEDED', { productId });
      } catch (err) {
        report.failed += 1;
        const reason = (err as Error).message;
        this.logger.warn(`Consume retry failed for order ${order.id}: ${reason}`);
        await this.auditService.logAudit(order.id, 'CONSUME_RETRY_FAILED', { productId, reason });
      }
    }

    if (report.scanned > 0) {
      this.logger.log(
        `Consume retry sweep: scanned=${report.scanned} consumed=${report.consumed} ` +
          `failed=${report.failed} skipped=${report.skipped}`,
      );
    }

    return report;
  }
}
