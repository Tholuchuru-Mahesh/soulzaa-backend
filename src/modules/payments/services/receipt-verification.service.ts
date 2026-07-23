import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PurchaseOrderStatus, WalletCurrency, WalletTxnReason } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { FinancialPolicyService } from 'src/modules/treasury/services/financial-policy.service';
import { WalletTransactionService } from 'src/modules/wallet/services/wallet-transaction.service';
import { PaymentProviderFactory } from '../adapters/payment-provider.factory';
import { VerifyPurchaseDto } from '../dto/purchase-order.dto';
import { PurchaseAuditService } from './purchase-audit.service';
import { PurchaseOrderService } from './purchase-order.service';

@Injectable()
export class ReceiptVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orderService: PurchaseOrderService,
    private readonly providerFactory: PaymentProviderFactory,
    private readonly walletTxService: WalletTransactionService,
    private readonly coinEconomyService: CoinEconomyService,
    private readonly financialPolicyService: FinancialPolicyService,
    private readonly auditService: PurchaseAuditService,
  ) {}

  /**
   * Verifies a payment receipt and credits Soul Coins to the user's wallet via WalletTransactionService
   */
  async verifyAndFulfillPurchase(dto: VerifyPurchaseDto, actorId?: string) {
    // 1. Treasury Economy Freeze & Risk Controls Check
    const isFrozen = await this.coinEconomyService.isEconomyFrozen();
    if (isFrozen) {
      throw new ForbiddenException(
        'Coin purchase verification is suspended due to Emergency Economy Freeze',
      );
    }

    // 2. Fetch purchase order
    const order = await this.orderService.getOrderById(dto.orderId);

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

    const providerTxnId = dto.providerTxnId ?? verificationResult.providerTxnId;

    // 4. Anti-Replay Duplicate Purchase Detection
    const existingReceipt = await this.prisma.paymentReceipt.findUnique({
      where: { providerTxnId },
    });
    if (existingReceipt && existingReceipt.isVerified) {
      throw new ConflictException(
        `Payment receipt '${providerTxnId}' has already been verified and credited (Anti-Replay Safeguard)`,
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

    // 6. Record Payment Receipt Row
    const receipt = await this.prisma.paymentReceipt.create({
      data: {
        purchaseOrderId: order.id,
        provider: order.provider,
        receiptData: dto.receiptData,
        signature: dto.signature,
        providerTxnId,
        isVerified: true,
        verificationResult: JSON.parse(JSON.stringify(verificationResult.rawPayload ?? {})),
        verifiedAt: new Date(),
      },
    });

    await this.auditService.logAudit(
      order.id,
      'RECEIPT_VERIFIED',
      { receiptId: receipt.id, providerTxnId },
      actorId,
    );

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

    // 8. Update Purchase Order status to COMPLETED
    const completedOrder = await this.orderService.updateOrderStatus(
      order.id,
      PurchaseOrderStatus.COMPLETED,
      providerTxnId,
      walletCreditResult.transactionId,
    );

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
    };
  }
}
