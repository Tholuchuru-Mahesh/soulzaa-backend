import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PurchaseOrderStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CreatePurchaseOrderDto } from '../dto/purchase-order.dto';
import { CoinPackageService } from './coin-package.service';
import { PurchaseAuditService } from './purchase-audit.service';

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly packageService: CoinPackageService,
    private readonly auditService: PurchaseAuditService,
  ) {}

  /**
   * Creates a purchase order with unique orderNumber & idempotencyKey
   */
  async createPurchaseOrder(userId: string, dto: CreatePurchaseOrderDto) {
    // Check idempotencyKey — scoped to the caller. The key is client-supplied,
    // so an unscoped lookup hands back another user's order body (orderNumber,
    // coin totals, price) to anyone who guesses or replays one. Scoping it means
    // a collision across users falls through to `create`, where the UNIQUE
    // constraint on idempotencyKey rejects it, rather than silently returning
    // someone else's order.
    const existingOrder = await this.prisma.purchaseOrder.findFirst({
      where: { idempotencyKey: dto.idempotencyKey, userId },
    });
    if (existingOrder) {
      return this.formatOrderResponse(existingOrder);
    }

    const pkg = await this.packageService.getPackageById(dto.packageId);
    if (!pkg.isActive) {
      throw new BadRequestException(`Coin package '${pkg.name}' is currently inactive`);
    }

    const baseCoins = BigInt(pkg.coins);
    const bonusCoins = BigInt(pkg.bonusCoins);
    const totalCoins = baseCoins + bonusCoins;

    const orderNumber = `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 mins order expiration

    const order = await this.prisma.purchaseOrder.create({
      data: {
        orderNumber,
        userId,
        packageId: pkg.id,
        provider: dto.provider,
        coinsAmount: baseCoins,
        bonusCoinsAmount: bonusCoins,
        totalCoins,
        priceAmount: pkg.priceAmount,
        currency: pkg.currency,
        status: PurchaseOrderStatus.CREATED,
        idempotencyKey: dto.idempotencyKey,
        metadata: dto.metadata ? JSON.parse(JSON.stringify(dto.metadata)) : undefined,
        expiresAt,
      },
    });

    await this.auditService.logAudit(order.id, 'PURCHASE_ORDER_CREATED', {
      orderNumber,
      userId,
      totalCoins: totalCoins.toString(),
    });

    return this.formatOrderResponse(order);
  }

  /**
   * Get purchase order by ID or orderNumber
   */
  async getOrderById(orderId: string) {
    const order = await this.prisma.purchaseOrder.findFirst({
      where: {
        OR: [{ id: orderId }, { orderNumber: orderId }],
      },
      include: { package: true, receipts: true },
    });

    if (!order) {
      throw new NotFoundException(`Purchase order '${orderId}' not found`);
    }

    return this.formatOrderResponse(order);
  }

  /**
   * Updates purchase order lifecycle status
   */
  async updateOrderStatus(
    orderId: string,
    status: PurchaseOrderStatus,
    providerTxnRef?: string,
    walletTxnId?: string,
  ) {
    const order = await this.prisma.purchaseOrder.findFirst({
      where: { OR: [{ id: orderId }, { orderNumber: orderId }] },
    });

    if (!order) {
      throw new NotFoundException(`Purchase order '${orderId}' not found`);
    }

    const completedAt = status === PurchaseOrderStatus.COMPLETED ? new Date() : undefined;

    const updated = await this.prisma.purchaseOrder.update({
      where: { id: order.id },
      data: {
        status,
        providerTxnRef: providerTxnRef ?? order.providerTxnRef,
        walletTransactionId: walletTxnId ?? order.walletTransactionId,
        completedAt,
      },
    });

    await this.auditService.logAudit(order.id, `ORDER_${status}`, {
      previousStatus: order.status,
      newStatus: status,
    });

    return this.formatOrderResponse(updated);
  }

  private formatOrderResponse(order: any) {
    return {
      ...order,
      coinsAmount: order.coinsAmount != null ? order.coinsAmount.toString() : '0',
      bonusCoinsAmount: order.bonusCoinsAmount != null ? order.bonusCoinsAmount.toString() : '0',
      totalCoins: order.totalCoins != null ? order.totalCoins.toString() : '0',
      priceAmount: order.priceAmount != null ? Number(order.priceAmount) : 0,
    };
  }
}
