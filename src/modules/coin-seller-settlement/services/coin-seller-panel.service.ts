import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinSellerInventoryService } from './coin-seller-inventory.service';

/**
 * Read side of the agency coin panel — what the Coins inventory, Buy coins and
 * Coins history screens render.
 *
 * Everything here is derived from the ledger rather than stored as a running
 * figure, so a number on screen can never disagree with the transactions
 * behind it.
 */
@Injectable()
export class CoinSellerPanelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: CoinSellerInventoryService,
  ) {}

  /** The wholesale tiers, in the order the panel shows them. */
  async listPackages() {
    const packages = await this.prisma.coinSellerInventoryPackage.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { priceAmount: 'asc' }],
    });

    return packages.map((pkg) => ({
      id: pkg.id,
      code: pkg.code,
      name: pkg.name,
      coinAmount: pkg.coinAmount.toString(),
      priceAmount: Number(pkg.priceAmount),
      priceCurrency: pkg.priceCurrency,
    }));
  }

  /**
   * The inventory screen: balances, the day's and month's sales, and the
   * detail block.
   */
  async getInventorySummary(sellerId: string) {
    const inventory = await this.inventory.getOrInitInventory(sellerId);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);

    // Summed from the sale ledger rather than kept as counters: a counter can
    // drift from the transactions it claims to summarise, and this figure is
    // shown next to the balance it must agree with.
    const [soldToday, soldThisMonth, lastCredited] = await Promise.all([
      this.prisma.coinSellerUserSaleTransaction.aggregate({
        _sum: { coinAmount: true },
        where: { sellerId, status: 'COMPLETED', createdAt: { gte: startOfToday } },
      }),
      this.prisma.coinSellerUserSaleTransaction.aggregate({
        _sum: { coinAmount: true },
        where: { sellerId, status: 'COMPLETED', createdAt: { gte: startOfMonth } },
      }),
      this.prisma.coinSellerInventoryPurchaseOrder.findFirst({
        where: { sellerId, status: 'INVENTORY_CREDITED' },
        orderBy: { creditedAt: 'desc' },
        select: { creditedAt: true, approvedBy: true },
      }),
    ]);

    return {
      inventoryId: inventory.id,
      country: inventory.country,
      availableBalance: inventory.availableBalance.toString(),
      purchasedTotal: inventory.purchasedTotal.toString(),
      reservedBalance: inventory.reservedBalance.toString(),
      soldTotal: inventory.soldTotal.toString(),
      soldToday: (soldToday._sum.coinAmount ?? BigInt(0)).toString(),
      soldThisMonth: (soldThisMonth._sum.coinAmount ?? BigInt(0)).toString(),
      lastRestockedAt: lastCredited?.creditedAt ?? null,
      addedByOfficial: lastCredited?.approvedBy ?? null,
    };
  }

  /**
   * The coins history screen. `type` filters the two chips; omitting it is the
   * "All" chip.
   */
  async listHistory(
    sellerId: string,
    options: { type?: 'SENT' | 'ADDED'; limit?: number; cursor?: string } = {},
  ) {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

    const sales =
      options.type === 'ADDED'
        ? []
        : await this.prisma.coinSellerUserSaleTransaction.findMany({
            where: { sellerId },
            orderBy: { createdAt: 'desc' },
            take: limit,
          });

    const purchases =
      options.type === 'SENT'
        ? []
        : await this.prisma.coinSellerInventoryPurchaseOrder.findMany({
            where: { sellerId, status: 'INVENTORY_CREDITED' },
            orderBy: { creditedAt: 'desc' },
            take: limit,
          });

    const entries = [
      ...sales.map((sale) => ({
        id: sale.id,
        type: 'SENT' as const,
        counterpartyId: sale.buyerId,
        coinAmount: sale.coinAmount.toString(),
        status: sale.status,
        occurredAt: sale.createdAt,
      })),
      ...purchases.map((order) => ({
        id: order.id,
        type: 'ADDED' as const,
        counterpartyId: order.approvedBy,
        coinAmount: order.coinAmount.toString(),
        status: order.status,
        occurredAt: order.creditedAt ?? order.updatedAt,
      })),
    ];

    // The two sources are each sorted, but interleaving them is not — so sort
    // the merged list before trimming, or the newest entries of one kind would
    // be dropped in favour of older entries of the other.
    entries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    return { entries: entries.slice(0, limit) };
  }
}
