import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentProvider,
  PurchaseOrderStatus,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WalletTransactionService } from 'src/modules/wallet/services/wallet-transaction.service';
import { DeveloperNotification } from '../dto/google-rtdn.dto';
import { PurchaseAuditService } from './purchase-audit.service';
import { PurchaseOrderService } from './purchase-order.service';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * Applies Play's real-time developer notifications.
 *
 * Only `voidedPurchaseNotification` is acted on. Everything else is recorded and
 * reported as unhandled, so the controller can still answer 200 — a non-2xx makes
 * Pub/Sub redeliver, and redelivering a notification nothing will ever act on is
 * a retry loop with no exit.
 */
@Injectable()
export class GoogleRtdnService {
  private readonly logger = new Logger(GoogleRtdnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderService: PurchaseOrderService,
    private readonly walletTxService: WalletTransactionService,
    private readonly auditService: PurchaseAuditService,
  ) {}

  async handleNotification(notification: DeveloperNotification): Promise<{ handled: boolean }> {
    // Google never sends a null/non-object body, but the decoded JSON is still
    // attacker-shaped in principle, and dereferencing a null here would throw
    // and turn a body that can NEVER succeed into a 500 — which makes Pub/Sub
    // retry it forever instead of dropping it after one well-formed "no".
    if (!notification || typeof notification !== 'object') {
      this.logger.warn('Ignoring RTDN with a null/non-object notification body');
      return { handled: false };
    }

    const voided = notification.voidedPurchaseNotification;
    if (!voided) {
      this.logger.log(`Ignoring RTDN with no voidedPurchaseNotification`);
      return { handled: false };
    }

    // `DeveloperNotification` is a TypeScript interface — erased at runtime.
    // The decoded JSON is attacker-shaped, so `orderId`/`purchaseToken` are
    // re-validated here, before either ever reaches a Prisma `where` clause.
    // Passing `undefined` into `where: { providerTxnRef: undefined }` would be
    // silently DROPPED by Prisma (this schema has no `strictUndefinedChecks`
    // preview feature), turning the lookup into an unfiltered `findFirst` that
    // can match an arbitrary order.
    const { orderId, purchaseToken } = voided;
    if (!isNonEmptyString(orderId) || !isNonEmptyString(purchaseToken)) {
      this.logger.warn(
        'Voided purchase notification is missing a valid orderId/purchaseToken; ignoring',
      );
      await this.auditService.logAudit(null, 'REFUND_IGNORED', {
        reason: 'Missing or non-string orderId/purchaseToken',
      });
      return { handled: false };
    }

    const order = await this.findOrder(orderId, purchaseToken);
    if (!order) {
      this.logger.warn(`Voided purchase '${orderId}' matches no Google Play purchase order`);
      return { handled: false };
    }

    if (order.status !== PurchaseOrderStatus.COMPLETED) {
      // Nothing was credited, so there is nothing to take back.
      await this.auditService.logAudit(order.id, 'REFUND_IGNORED', {
        reason: `Order status is ${order.status}`,
        orderId,
      });
      return { handled: false };
    }

    try {
      const amount = this.toSafeAmount(order.totalCoins, order.orderNumber);

      // Idempotent on the Play order ID: a redelivered notification derives the
      // same idempotencyKey, so `reverseWallet` finds the existing reversal
      // transaction and returns it rather than debiting twice.
      await this.walletTxService.reverseWallet(
        {
          userId: order.userId,
          amount,
          currency: WalletCurrency.GOLD,
          reason: WalletTxnReason.PURCHASE_REVERSAL,
          idempotencyKey: `REVERSAL_${orderId}`,
          referenceType: 'purchase_order',
          referenceId: order.id,
          description: `Play refund: ${order.orderNumber}`,
        },
        undefined,
      );

      await this.orderService.updateOrderStatus(order.id, PurchaseOrderStatus.REFUNDED);
      await this.auditService.logAudit(order.id, 'PURCHASE_REFUNDED', {
        orderId,
        refundType: voided.refundType,
      });

      this.logger.log(`Reversed ${order.totalCoins} coins for refunded order ${order.orderNumber}`);
      return { handled: true };
    } catch (err) {
      // A transient failure (economy freeze, DB error) must NOT be swallowed
      // into `{handled:false}` — the controller would answer 200, Pub/Sub would
      // stop retrying, and a real refund would silently never land. Audit it so
      // a repeatedly-failing reversal is visible, then rethrow so the caller
      // sees a non-2xx and Pub/Sub retries until the underlying issue clears.
      //
      // The audit call itself is wrapped separately: if `logAudit` throws (e.g.
      // the DB is the thing that's down), that must not replace `err` — the
      // original cause is what a retry needs to eventually resolve, and losing
      // it behind an unrelated audit-write failure would make this much harder
      // to debug than not auditing at all.
      try {
        await this.auditService.logAudit(order.id, 'REFUND_REVERSAL_FAILED', {
          orderId,
          error: (err as Error).message,
        });
      } catch (auditErr) {
        this.logger.error(
          `Failed to audit REFUND_REVERSAL_FAILED for order '${order.id}': ${(auditErr as Error).message}`,
        );
      }
      throw err;
    }
  }

  /**
   * `Number()` silently truncates above `Number.MAX_SAFE_INTEGER`, which would
   * reverse the WRONG amount rather than fail loudly. No coin package this
   * platform sells is anywhere near this size, so throwing here only ever
   * fires on a corrupted row — which is exactly when it should be loud.
   */
  private toSafeAmount(totalCoins: bigint, orderNumber: string): number {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (totalCoins > maxSafe) {
      throw new Error(
        `Order '${orderNumber}' totalCoins ${totalCoins.toString()} exceeds Number.MAX_SAFE_INTEGER; refusing a lossy reversal`,
      );
    }
    return Number(totalCoins);
  }

  /**
   * `providerTxnRef` holds the Play order ID recorded at verification. The receipt
   * fallback covers orders whose reference was never written — the purchase token
   * is stored as the receipt payload.
   *
   * Both queries are scoped to `PaymentProvider.GOOGLE_PLAY`: `providerTxnRef`
   * and `receiptData` are not unique across providers (the schema's own index is
   * `@@index([provider, providerTxnRef])`), so an attacker-chosen orderId/token
   * could otherwise match a Stripe/Razorpay/Apple/mock order instead. `orderBy`
   * makes the match deterministic if duplicates ever exist.
   */
  private async findOrder(playOrderId: string, purchaseToken: string) {
    const byRef = await this.prisma.purchaseOrder.findFirst({
      where: { provider: PaymentProvider.GOOGLE_PLAY, providerTxnRef: playOrderId },
      orderBy: { createdAt: 'desc' },
    });
    if (byRef) return byRef;

    const receipt = await this.prisma.paymentReceipt.findFirst({
      where: { provider: PaymentProvider.GOOGLE_PLAY, receiptData: purchaseToken },
      orderBy: { createdAt: 'desc' },
      include: { purchaseOrder: true },
    });
    return receipt?.purchaseOrder ?? null;
  }
}
