import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class CoinSellerRelationshipService {
  private readonly logger = new Logger(CoinSellerRelationshipService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves active coin seller mapping for a buyer. Returns null if buyer bought directly from platform.
   */
  async getActiveSellerForBuyer(buyerId: string) {
    return this.prisma.coinSellerRelationship.findFirst({
      where: {
        buyerId,
        status: 'ACTIVE',
      },
    });
  }

  /**
   * Assigns a buyer to a coin seller or updates an existing relationship.
   */
  async assignBuyerToSeller(sellerId: string, buyerId: string) {
    return this.prisma.coinSellerRelationship.upsert({
      where: {
        sellerId_buyerId: { sellerId, buyerId },
      },
      update: {
        status: 'ACTIVE',
        effectiveFrom: new Date(),
        effectiveUntil: null,
      },
      create: {
        sellerId,
        buyerId,
        status: 'ACTIVE',
      },
    });
  }

  /**
   * Terminates a seller-buyer relationship.
   */
  async terminateRelationship(sellerId: string, buyerId: string) {
    return this.prisma.coinSellerRelationship.updateMany({
      where: { sellerId, buyerId, status: 'ACTIVE' },
      data: {
        status: 'TERMINATED',
        effectiveUntil: new Date(),
      },
    });
  }
}
