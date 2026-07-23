import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { CoinSellerRelationshipService } from './coin-seller-relationship.service';

@Injectable()
export class CoinSellerValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coinEconomyService: CoinEconomyService,
    private readonly relationshipService: CoinSellerRelationshipService,
  ) {}

  /**
   * Validates pre-conditions before executing coin seller settlement.
   */
  async validateSettlement(purchaseTxnId: string, buyerId: string) {
    // 1. Check Treasury Economy Freeze
    const isFrozen = await this.coinEconomyService.isEconomyFrozen();
    if (isFrozen) {
      throw new ForbiddenException(
        'Coin seller settlement suspended due to Treasury Economy Freeze',
      );
    }

    // 2. Check Idempotency / Replay protection
    const existing = await this.prisma.coinSellerSettlement.findUnique({
      where: { purchaseTxnId },
    });
    if (existing) {
      return { isDuplicate: true, existingSettlement: existing, relationship: null };
    }

    // 3. Validate active Buyer-Seller relationship
    const relationship = await this.relationshipService.getActiveSellerForBuyer(buyerId);
    if (!relationship) {
      // Independent buyer bought directly without a coin seller
      return { isDuplicate: false, existingSettlement: null, relationship: null };
    }

    // 4. Validate Seller account status
    const sellerUser = await this.prisma.user.findUnique({
      where: { id: relationship.sellerId },
      select: { id: true, status: true },
    });

    if (!sellerUser || sellerUser.status === 'BANNED' || sellerUser.status === 'SUSPENDED') {
      throw new ForbiddenException(`Coin seller account '${relationship.sellerId}' is not active`);
    }

    return { isDuplicate: false, existingSettlement: null, relationship };
  }
}
