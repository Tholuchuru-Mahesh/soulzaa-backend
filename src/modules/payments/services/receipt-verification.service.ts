import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  PaymentProvider,
  PurchaseOrderStatus,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { FinancialPolicyService } from 'src/modules/treasury/services/financial-policy.service';
import { WalletTransactionService } from 'src/modules/wallet/services/wallet-transaction.service';
import { GooglePlayApiClient } from '../adapters/google-play-api.client';
import { PaymentProviderFactory } from '../adapters/payment-provider.factory';
import { VerifyPurchaseDto } from '../dto/purchase-order.dto';
import { PurchaseAuditService } from './purchase-audit.service';
import { PurchaseOrderService } from './purchase-order.service';

@Injectable()
export class ReceiptVerificationService {
  private readonly logger = new Logger(ReceiptVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderService: PurchaseOrderService,
    private readonly providerFactory: PaymentProviderFactory,
    private readonly walletTxService: WalletTransactionService,
    private readonly coinEconomyService: CoinEconomyService,
    private readonly financialPolicyService: FinancialPolicyService,
    private readonly auditService: PurchaseAuditService,
    private readonly playApiClient: GooglePlayApiClient,
  ) {}

  /**
   * Verifies a payment receipt and credits Soul Coins to the user's wallet via WalletTransactionService.
   * Enforces that the caller owns the order — this is the only path reachable from a
   * user-facing controller.
   */
  async verifyAndFulfillPurchase(dto: VerifyPurchaseDto, actorId: string) {
    return this.fulfill(dto, actorId, true);
  }

  /**
   * Admin-only fulfillment path backing `SuperAdminPurchaseController.retryVerification`.
   * Deliberately bypasses the caller-ownership check that `verifyAndFulfillPurchase`
   * enforces, because a super admin retrying a stuck or failed order is routinely
   * acting on an order that does not belong to them. This is safe *only* because the
   * only caller is gated behind `@RequireRoles('SUPER_ADMIN')` plus RBAC permission
   * guards — do not call this from, or expose it through, any user-facing controller.
   *
   * Every other check (Google Play product/purchase/consumption/account-binding
   * integrity, anti-replay, policy limit) still runs exactly as it does for the
   * ownership-enforced path; only ownership is skipped. The wallet is always
   * credited to the order's own `userId`, never to the admin, and the admin's
   * identity is recorded via a distinct `PURCHASE_VERIFIED_BY_ADMIN` audit entry so
   * an admin-driven settlement stays distinguishable in the audit trail forever.
   */
  async verifyAndFulfillPurchaseAsAdmin(dto: VerifyPurchaseDto, adminId: string) {
    const result = await this.fulfill(dto, adminId, false);
    await this.auditService.logAudit(
      result.orderId,
      'PURCHASE_VERIFIED_BY_ADMIN',
      { adminId, userId: result.userId },
      adminId,
    );
    return result;
  }

  private async fulfill(dto: VerifyPurchaseDto, actorId: string, enforceOwnership: boolean) {
    // 1. Treasury Economy Freeze & Risk Controls Check
    const isFrozen = await this.coinEconomyService.isEconomyFrozen();
    if (isFrozen) {
      throw new ForbiddenException(
        'Coin purchase verification is suspended due to Emergency Economy Freeze',
      );
    }

    // 2. Fetch purchase order
    const order = await this.orderService.getOrderById(dto.orderId);

    // The caller must own the order. Previously `actorId` was recorded for audit
    // but never compared, so any authenticated user could drive another user's
    // order through verification. The admin path opts out of this check
    // explicitly via `enforceOwnership` — see `verifyAndFulfillPurchaseAsAdmin`.
    if (enforceOwnership && order.userId !== actorId) {
      throw new ForbiddenException('Purchase order does not belong to the current user');
    }

    // If order already completed, return idempotent response
    if (order.status === PurchaseOrderStatus.COMPLETED) {
      return {
        isVerified: true,
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: PurchaseOrderStatus.COMPLETED,
        totalCoins: order.totalCoins,
        walletTransactionId: order.walletTransactionId,
        alreadyProcessed: true,
        userId: order.userId,
      };
    }

    if (
      order.status === PurchaseOrderStatus.CANCELLED ||
      order.status === PurchaseOrderStatus.EXPIRED
    ) {
      throw new BadRequestException(`Cannot verify purchase order in '${order.status}' state`);
    }

    // 3. Resolve Provider Adapter & Verify Receipt Payload
    const adapter = this.providerFactory.getAdapter(order.provider);
    const verificationResult = await adapter.verifyReceipt(dto.receiptData, dto.signature, order);

    if (!verificationResult.isVerified) {
      await this.orderService.updateOrderStatus(order.id, PurchaseOrderStatus.FAILED);
      await this.auditService.logAudit(
        order.id,
        'PURCHASE_FAILED',
        { reason: verificationResult.errorMessage },
        actorId,
      );
      throw new BadRequestException(
        `Payment receipt verification failed: ${verificationResult.errorMessage ?? 'Invalid receipt'}`,
      );
    }

    // A valid receipt is not automatically a receipt for THIS order. Each check
    // below is a distinct way a genuine purchase could settle an order it did not
    // pay for.
    const failIntegrity = async (reason: string): Promise<never> => {
      await this.orderService.updateOrderStatus(order.id, PurchaseOrderStatus.FAILED);
      await this.auditService.logAudit(order.id, 'PURCHASE_FAILED', { reason }, actorId);
      throw new BadRequestException(reason);
    };

    const expectedProductId: string | undefined = order.package?.googleProductId ?? undefined;

    if (order.provider === PaymentProvider.GOOGLE_PLAY) {
      // A package with no googleProductId is not sellable on Android at all, so
      // no Play receipt can legitimately settle this order. Reject regardless of
      // what Google returned.
      if (!expectedProductId) {
        return failIntegrity(
          `Order package has no Google Play product ID configured and cannot be settled by a Play receipt`,
        );
      }

      // Google documents `ProductPurchase.productId` as "may not be present", so
      // an unconditional `!==` comparison rejects 100% of purchases the moment
      // Google omits it. Only compare when a value actually came back.
      //
      // Dropping the check in the absent case is safe because it was never the
      // thing binding token to product: GooglePlayApiClient interpolates the
      // EXPECTED productId into the request path
      // (`/purchases/products/{productId}/tokens/{token}`), so a token belonging
      // to a different product 404s at the API call and never reaches here. The
      // URL-path binding is the guarantee; this comparison is defence in depth.
      if (verificationResult.productId) {
        if (verificationResult.productId !== expectedProductId) {
          return failIntegrity(
            `Receipt product '${verificationResult.productId}' does not match order package '${expectedProductId}'`,
          );
        }
      } else {
        this.logger.warn(
          `Google returned no productId for order ${order.id}; relying on the URL-path product binding (expected '${expectedProductId}')`,
        );
      }

      if (verificationResult.purchaseState !== 0) {
        return failIntegrity(
          `Purchase is not in the purchased state (purchaseState=${verificationResult.purchaseState})`,
        );
      }

      if (verificationResult.consumptionState !== 0) {
        return failIntegrity('Purchase has already been consumed and cannot be credited again');
      }

      if (verificationResult.externalAccountId !== order.userId) {
        return failIntegrity('Purchase is bound to a different account than the order');
      }
    }

    // The verified value must win. `dto.providerTxnId` is client-controlled and
    // this same identifier doubles as the wallet idempotency key below
    // (`RECHARGE_${providerTxnId}`) as well as the anti-replay lookup. If the
    // client's value took priority, a caller could settle two different orders
    // from one real purchase: verify order A with `providerTxnId: 'a'`, then
    // verify order B with the SAME receipt token but `providerTxnId: 'b'` — the
    // anti-replay lookup and the idempotency key would both look fresh even
    // though the underlying purchase already paid for order A. `||` (not `??`)
    // is deliberate: an adapter that returns `''` on success must not let the
    // client's value stand in for it silently.
    const providerTxnId = verificationResult.providerTxnId || dto.providerTxnId;

    // 4. Anti-Replay Duplicate Purchase Detection
    const existingReceipt = await this.prisma.paymentReceipt.findUnique({
      where: { providerTxnId },
    });
    if (existingReceipt && existingReceipt.isVerified) {
      throw new ConflictException(
        `Payment receipt '${providerTxnId}' has already been verified and credited (Anti-Replay Safeguard)`,
      );
    }

    // An UNVERIFIED leftover is the self-healing retry path (see step 6) — but
    // only for the order that created it. Letting a different order adopt it
    // would settle that order off a purchase it never paid for: the wallet
    // idempotency key `RECHARGE_${providerTxnId}` would return the first order's
    // existing transaction, so no new coins move, yet the second order would be
    // marked COMPLETED against it. Retry the order that owns the token.
    if (existingReceipt && existingReceipt.purchaseOrderId !== order.id) {
      throw new ConflictException(
        `Payment receipt '${providerTxnId}' belongs to a different purchase order (Anti-Replay Safeguard)`,
      );
    }

    // 5. Financial Policy Treasury Limit Check
    const totalCoinsNum = Number(order.totalCoins);
    const isWithinPolicy = await this.financialPolicyService.validatePolicyLimit(
      'max_coin_purchase_amount',
      totalCoinsNum,
    );
    if (!isWithinPolicy) {
      throw new BadRequestException(
        `Purchased coin quantity exceeds platform max purchase limit policy`,
      );
    }

    // 6. Record Payment Receipt Row — deliberately UNVERIFIED at this point.
    //
    // `isVerified: true` is what the anti-replay check above blocks on, and this
    // row is committed on its own (no transaction spans it and the credit). If
    // the row were written as verified and the credit below then threw — economy
    // freeze, ledger contention, a database blip — every retry, including the
    // admin retry path, would 409 forever against a receipt that never bought
    // any coins. The user is charged, holds nothing, and the only recovery is
    // Google's 3-day auto-void. Flipping the flag only after the credit lands
    // makes a crash between the two steps self-healing: the leftover row is
    // unverified, the anti-replay check waves the retry through, and the wallet
    // idempotency key (`RECHARGE_${providerTxnId}`) stops the credit applying
    // twice if it actually did succeed.
    const receiptPayload = {
      purchaseOrderId: order.id,
      provider: order.provider,
      receiptData: dto.receiptData,
      signature: dto.signature,
      verificationResult: JSON.parse(JSON.stringify(verificationResult.rawPayload ?? {})),
      isVerified: false,
      verifiedAt: null,
    };

    // `providerTxnId` is UNIQUE, so a retry that found an unverified leftover
    // above must reuse that row rather than insert a colliding one.
    const receipt = existingReceipt
      ? await this.prisma.paymentReceipt.update({
          where: { id: existingReceipt.id },
          data: receiptPayload,
        })
      : await this.prisma.paymentReceipt.create({
          data: { ...receiptPayload, providerTxnId },
        });

    // 7. Credit Wallet via WalletTransactionService (Immutable Double-Entry Ledger Entry)
    const walletCreditResult = await this.walletTxService.creditWallet(
      {
        userId: order.userId,
        amount: totalCoinsNum,
        currency: WalletCurrency.GOLD,
        reason: WalletTxnReason.RECHARGE,
        idempotencyKey: `RECHARGE_${providerTxnId}`,
        referenceType: 'purchase_order',
        referenceId: order.id,
        description: `Coin Purchase: ${order.orderNumber}`,
      },
      actorId,
    );

    // The coins exist now, so the receipt may finally claim to be verified and
    // start blocking replays.
    await this.prisma.paymentReceipt.update({
      where: { id: receipt.id },
      data: { isVerified: true, verifiedAt: new Date() },
    });

    await this.auditService.logAudit(
      order.id,
      'RECEIPT_VERIFIED',
      { receiptId: receipt.id, providerTxnId },
      actorId,
    );

    // 8. Update Purchase Order status to COMPLETED
    const completedOrder = await this.orderService.updateOrderStatus(
      order.id,
      PurchaseOrderStatus.COMPLETED,
      providerTxnId,
      walletCreditResult.transactionId,
    );

    // Consume LAST. If the credit had failed, the token stays unconsumed and Play
    // redelivers it, so the user's money is never taken without coins. A failure
    // here is logged but not fatal: the coins are already credited, and Play's own
    // consumption state prevents a second credit.
    //
    // `expectedProductId` (not `verificationResult.productId`) is what identifies
    // the SKU here — Google may omit productId from the response, and falling
    // back to it would silently skip the consume for exactly those purchases,
    // stranding the SKU as owned-and-unconsumed.
    if (order.provider === PaymentProvider.GOOGLE_PLAY && expectedProductId) {
      try {
        await this.playApiClient.consumeProductPurchase(expectedProductId, dto.receiptData);
        // Stamped only on success. A COMPLETED Google Play order with a null
        // `consumedAt` is the work queue for
        // `PurchaseReconciliationService.retryPendingConsumes`, which is the only
        // thing standing between a failed consume here and a SKU the user can
        // never re-buy.
        await this.prisma.purchaseOrder.update({
          where: { id: order.id },
          data: { consumedAt: new Date() },
        });
      } catch (err) {
        await this.auditService.logAudit(
          order.id,
          'CONSUME_FAILED',
          { reason: (err as Error).message },
          actorId,
        );
      }
    }

    await this.auditService.logAudit(
      order.id,
      'PURCHASE_COMPLETED',
      { walletTransactionId: walletCreditResult.transactionId },
      actorId,
    );

    return {
      isVerified: true,
      orderId: completedOrder.id,
      orderNumber: completedOrder.orderNumber,
      status: completedOrder.status,
      providerTxnRef: providerTxnId,
      totalCoins: completedOrder.totalCoins,
      walletTransactionId: walletCreditResult.transactionId,
      completedAt: completedOrder.completedAt,
      userId: order.userId,
    };
  }
}
