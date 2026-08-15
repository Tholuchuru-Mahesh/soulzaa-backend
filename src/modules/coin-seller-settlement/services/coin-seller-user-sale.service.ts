import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { resolveUserCountryCode } from '../utils/resolve-user-country';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { WalletCurrency, WalletTxnReason } from '@prisma/client';

@Injectable()
export class CoinSellerUserSaleService {
  private readonly logger = new Logger(CoinSellerUserSaleService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
  ) {}

  /**
   * Sells coins from a Coin Seller's inventory to a User.
   *
   * Enforces that both the seller and the buyer are in the same country
   * (PRD §20), that the sale settles exactly once however many times it is
   * retried (PRD §32), and that concurrent sales cannot drive the seller's
   * inventory negative (PRD §18).
   *
   * `idempotencyKey` is caller-supplied and required. It was previously a
   * fresh `randomUUID()` generated inside this method, which meant a retried
   * request — the exact case idempotency exists for — created a second sale
   * and credited the buyer twice.
   */
  async sellCoinsToUser(sellerId: string, buyerId: string, amount: number, idempotencyKey: string) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Amount must be a positive whole number of coins',
      );
    }

    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'idempotencyKey is required for coin sales',
      );
    }

    // 0. Idempotent replay — return the original settlement untouched.
    const replay = await this.prisma.coinSellerUserSaleTransaction.findUnique({
      where: { idempotencyKey: key },
    });
    if (replay) return replay;

    // 1. Validate Seller Inventory and Country
    const inventory = await this.prisma.coinSellerInventory.findUnique({
      where: { sellerId },
    });
    if (!inventory) {
      throw new BusinessException(ERROR_CODES.NOT_FOUND, 'Seller inventory not found');
    }
    if (inventory.availableBalance < BigInt(amount)) {
      throw new BusinessException(
        ERROR_CODES.INSUFFICIENT_BALANCE,
        'Insufficient seller inventory',
      );
    }

    // 2. Validate Buyer and Country Restriction
    const buyer = await this.prisma.user.findUnique({
      where: { id: buyerId },
      select: { id: true },
    });
    if (!buyer) {
      throw new BusinessException(ERROR_CODES.NOT_FOUND, 'Buyer not found');
    }

    // Resolved the same way as the seller's, so "India" and "IN" are one
    // country rather than two. Comparing the raw columns blocked sales
    // between a seller and buyer who had written their country differently.
    const buyerCountry = await resolveUserCountryCode(this.prisma, buyerId);
    if (!buyerCountry) {
      throw new BusinessException(ERROR_CODES.VALIDATION_ERROR, 'Buyer country is not set');
    }

    // Country restriction: Seller and Buyer must be in the same country (PRD §8, §20)
    if (inventory.country.toUpperCase() !== buyerCountry) {
      throw new BusinessException(
        ERROR_CODES.FORBIDDEN,
        `Coin Seller in ${inventory.country} cannot sell to User in ${buyerCountry}`,
      );
    }

    // 3. Execute Transaction
    return this.prisma.$transaction(async (tx: any) => {
      // Re-read the inventory under a real row lock. The check above is only a
      // cheap early rejection: without `FOR UPDATE`, two concurrent sales both
      // pass it, both decrement, and the balance goes negative. A plain
      // `findUnique` inside the transaction does NOT lock the row — it issues an
      // ordinary SELECT — which is why this is raw SQL.
      await tx.$queryRaw`SELECT id FROM coin_seller_inventories WHERE id = ${inventory.id}::uuid FOR UPDATE`;

      const lockedInventory = await tx.coinSellerInventory.findUnique({
        where: { id: inventory.id },
      });

      if (!lockedInventory || lockedInventory.availableBalance < BigInt(amount)) {
        throw new BusinessException(
          ERROR_CODES.INSUFFICIENT_BALANCE,
          'Insufficient seller inventory',
        );
      }

      // Deduct inventory
      const updatedInventory = await tx.coinSellerInventory.update({
        where: { id: inventory.id },
        data: {
          availableBalance: { decrement: amount },
          soldTotal: { increment: amount },
          version: { increment: 1 },
        },
      });

      // Credit User's GOLD Wallet. The wallet key is derived from the caller's
      // key so the wallet layer's own idempotency collapses a replay that
      // somehow reaches this far.
      const creditResult = await this.wallet.credit(
        {
          userId: buyerId,
          currency: WalletCurrency.GOLD,
          amount,
          reason: WalletTxnReason.COIN_SELLER_CREDIT,
          idempotencyKey: `wallet-coin-seller-sale-${key}`,
          referenceType: 'CoinSellerUserSaleTransaction',
          actorId: sellerId,
        },
        tx,
      );

      // Create Sale Transaction Record
      const sale = await tx.coinSellerUserSaleTransaction.create({
        data: {
          sellerId,
          inventoryId: inventory.id,
          buyerId,
          coinAmount: amount,
          sellerCountry: inventory.country,
          buyerCountry,
          status: 'COMPLETED',
          idempotencyKey: key,
          buyerWalletTxnId: creditResult.transactionId,
        },
      });

      // Audit Log
      await tx.coinSellerInventoryAudit.create({
        data: {
          sellerId,
          inventoryId: inventory.id,
          action: 'INVENTORY_SOLD',
          coinDelta: -amount,
          balanceBefore: lockedInventory.availableBalance,
          balanceAfter: updatedInventory.availableBalance,
          referenceType: 'CoinSellerUserSaleTransaction',
          referenceId: sale.id,
          actorId: sellerId,
        },
      });

      return sale;
    });
  }
}
