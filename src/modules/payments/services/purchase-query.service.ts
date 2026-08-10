import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { OrderQueryDto } from '../dto/purchase-order.dto';

@Injectable()
export class PurchaseQueryService {
  constructor(private readonly prisma: PrismaService) {}

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
   * Order details for a specific user.
   *
   * `userId` is required: without it this endpoint returned any order to any
   * authenticated caller. A foreign order 404s rather than 403s, so the response
   * does not confirm that the ID exists.
   */
  async getOrderDetails(orderId: string, userId: string) {
    const order = await this.prisma.purchaseOrder.findFirst({
      where: {
        userId,
        OR: [{ id: orderId }, { orderNumber: orderId }],
      },
      include: { package: true, receipts: true },
    });

    if (!order) {
      throw new NotFoundException(`Purchase order '${orderId}' not found`);
    }

    return {
      ...order,
      coinsAmount: order.coinsAmount.toString(),
      bonusCoinsAmount: order.bonusCoinsAmount.toString(),
      totalCoins: order.totalCoins.toString(),
      priceAmount: Number(order.priceAmount),
    };
  }
}
