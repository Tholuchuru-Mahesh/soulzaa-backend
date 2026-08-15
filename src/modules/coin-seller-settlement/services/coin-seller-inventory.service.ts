import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';

@Injectable()
export class CoinSellerInventoryService {
  private readonly logger = new Logger(CoinSellerInventoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The country this seller is authorised to sell in (PRD §20).
   *
   * Resolved from the seller's own profile rather than passed in: the country
   * is one half of the cross-border check in `CoinSellerUserSaleService`, so a
   * caller-supplied value would let a seller widen their own territory. It was
   * previously hardcoded to `'GLOBAL'`, which no real buyer country ever equals
   * — that placeholder made every sale fail the restriction check.
   *
   * A seller with no country on file is rejected outright. Defaulting would
   * either open cross-border selling or silently recreate the unsellable
   * inventory this replaces.
   */
  private async resolveSellerCountry(sellerId: string): Promise<string> {
    const seller = await this.prisma.user.findUnique({
      where: { id: sellerId },
      select: { country: true },
    });
    if (!seller?.country) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Coin Seller has no country on file; set the seller country before purchasing inventory',
      );
    }
    return seller.country;
  }

  /**
   * Initializes or returns the seller's inventory profile.
   *
   * `country` is optional and exists only for callers that have already
   * resolved it; when omitted it comes from the seller's profile.
   */
  async getOrInitInventory(sellerId: string, country?: string) {
    const inventory = await this.prisma.coinSellerInventory.findUnique({
      where: { sellerId },
    });
    if (inventory) return inventory;

    const resolved = country ?? (await this.resolveSellerCountry(sellerId));
    return this.prisma.coinSellerInventory.create({
      data: { sellerId, country: resolved },
    });
  }

  /**
   * Submits a purchase order for a seller to buy inventory from the platform.
   *
   * `idempotencyKey` is caller-supplied and required (PRD §32): a retried
   * submission must not queue a second order for the same money. The key was
   * previously a fresh `randomUUID()` per call, which satisfied the column's
   * uniqueness constraint while providing no replay protection at all.
   */
  async createPurchaseOrder(sellerId: string, packageId: string, idempotencyKey: string) {
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'idempotencyKey is required for inventory purchase orders',
      );
    }

    // Replay check first: a retry must short-circuit before any validation that
    // could have changed since the original call (e.g. the package going
    // inactive), or the same request would succeed once and then start failing.
    const existing = await this.prisma.coinSellerInventoryPurchaseOrder.findUnique({
      where: { idempotencyKey: key },
    });
    if (existing) return existing;

    const pkg = await this.prisma.coinSellerInventoryPackage.findUnique({
      where: { id: packageId },
    });
    if (!pkg || !pkg.isActive) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Invalid or inactive inventory package',
      );
    }

    const inventory = await this.getOrInitInventory(sellerId);

    return this.prisma.coinSellerInventoryPurchaseOrder.create({
      data: {
        sellerId,
        inventoryId: inventory.id,
        packageCode: pkg.code,
        coinAmount: pkg.coinAmount,
        priceAmount: pkg.priceAmount,
        priceCurrency: pkg.priceCurrency,
        idempotencyKey: key,
      },
    });
  }

  /**
   * Approves a purchase order and credits the seller's inventory.
   *
   * Inventory is moved out of the platform treasury rather than conjured
   * (PRD §17: "inventory must never appear from nowhere"). Previously this
   * incremented the seller's balance with no offsetting debit anywhere, so
   * total coin supply grew silently on every approval and no reconciliation
   * could detect it.
   */
  /**
   * Credits an order's coins from the treasury.
   *
   * [adminId] is written to `approvedBy` and to the audit's `actorId`, both
   * uuid columns — pass null for a credit no human approved (the Razorpay
   * webhook) and name the origin in [source], rather than inventing an id.
   */
  async approvePurchaseOrder(orderId: string, adminId: string | null, source?: string) {
    return this.prisma.$transaction(async (tx: any) => {
      // Lock the order before reading its status: two concurrent approvals
      // would otherwise both observe PENDING and both credit the inventory.
      await tx.$queryRaw`SELECT id FROM coin_seller_inventory_purchase_orders WHERE id = ${orderId}::uuid FOR UPDATE`;

      const order = await tx.coinSellerInventoryPurchaseOrder.findUnique({
        where: { id: orderId },
        include: { inventory: true },
      });

      if (!order) {
        throw new BusinessException(ERROR_CODES.NOT_FOUND, 'Purchase order not found');
      }
      // Only these two are approvable, and both exist in InventoryPurchaseStatus.
      // This previously also accepted 'PENDING_APPROVAL', which is not a member
      // of the enum and so could never match any stored row.
      if (order.status !== 'PENDING_PAYMENT' && order.status !== 'PAYMENT_VERIFIED') {
        throw new BusinessException(ERROR_CODES.VALIDATION_ERROR, 'Order not in a pending state');
      }

      // ── Source the coins from the treasury (PRD §17) ────────────
      await tx.$queryRaw`SELECT id FROM treasury_reserves FOR UPDATE`;
      const reserve = await tx.treasuryReserve.findFirst();
      if (!reserve) {
        throw new BusinessException(
          ERROR_CODES.VALIDATION_ERROR,
          'Treasury reserve is not initialised; cannot issue seller inventory',
        );
      }
      if (reserve.treasuryBalance < order.coinAmount) {
        throw new BusinessException(
          ERROR_CODES.INSUFFICIENT_BALANCE,
          'Treasury balance cannot cover this inventory purchase',
        );
      }
      await tx.treasuryReserve.update({
        where: { id: reserve.id },
        data: { treasuryBalance: { decrement: order.coinAmount } },
      });

      // Update Order
      // INVENTORY_CREDITED, not 'COMPLETED': the latter is not a member of
      // InventoryPurchaseStatus, so Postgres rejected the write and the whole
      // approval transaction rolled back. TypeScript did not catch it because
      // `tx` is typed `any`.
      const approvedOrder = await tx.coinSellerInventoryPurchaseOrder.update({
        where: { id: orderId },
        data: {
          status: 'INVENTORY_CREDITED',
          approvedBy: adminId,
          approvedAt: new Date(),
          creditedAt: new Date(),
        },
      });

      // Update Inventory
      const updatedInventory = await tx.coinSellerInventory.update({
        where: { id: order.inventoryId },
        data: {
          purchasedTotal: { increment: order.coinAmount },
          availableBalance: { increment: order.coinAmount },
          version: { increment: 1 },
        },
      });

      // Audit Log
      await tx.coinSellerInventoryAudit.create({
        data: {
          sellerId: order.sellerId,
          inventoryId: order.inventoryId,
          action: 'INVENTORY_PURCHASED',
          coinDelta: order.coinAmount,
          balanceBefore: order.inventory.availableBalance,
          balanceAfter: updatedInventory.availableBalance,
          referenceType: 'CoinSellerInventoryPurchaseOrder',
          referenceId: order.id,
          actorId: adminId,
          details: { treasuryReserveId: reserve.id, ...(source ? { source } : {}) },
        },
      });

      return approvedOrder;
    });
  }
}
