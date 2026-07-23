import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { OrderQueryDto } from '../dto/purchase-order.dto';
import { PurchaseOrderService } from './purchase-order.service';

@Injectable()
export class PurchaseQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orderService: PurchaseOrderService,
  ) {}

  /**
   * Get purchase history for a specific user
   */
  async getUserPurchaseHistory(userId: string, dto: OrderQueryDto) {
    const { status, provider, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (status) where.status = status.toUpperCase();
    if (provider) where.provider = provider.toUpperCase();

    const [total, orders] = await Promise.all([
      this.prisma.purchaseOrder.count({ where }),
      this.prisma.purchaseOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { package: true },
      }),
    ]);

    const formattedOrders = orders.map((o) => ({
      ...o,
      coinsAmount: o.coinsAmount.toString(),
      bonusCoinsAmount: o.bonusCoinsAmount.toString(),
      totalCoins: o.totalCoins.toString(),
      priceAmount: Number(o.priceAmount),
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: formattedOrders,
    };
  }

  /**
   * List all purchase orders for Super Admin view
   */
  async listAllOrders(dto: OrderQueryDto) {
    const { status, provider, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status.toUpperCase();
    if (provider) where.provider = provider.toUpperCase();

    const [total, orders] = await Promise.all([
      this.prisma.purchaseOrder.count({ where }),
      this.prisma.purchaseOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { package: true, receipts: true },
      }),
    ]);

    const formattedOrders = orders.map((o) => ({
      ...o,
      coinsAmount: o.coinsAmount.toString(),
      bonusCoinsAmount: o.bonusCoinsAmount.toString(),
      totalCoins: o.totalCoins.toString(),
      priceAmount: Number(o.priceAmount),
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: formattedOrders,
    };
  }

  /**
   * Get purchase order details
   */
  async getOrderDetails(orderId: string) {
    return this.orderService.getOrderById(orderId);
  }
}
