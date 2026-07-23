import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class TreasuryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves active global Treasury Reserve tracking row
   */
  async getTreasuryReserve() {
    let reserve = await this.prisma.treasuryReserve.findFirst();
    if (!reserve) {
      reserve = await this.prisma.treasuryReserve.create({
        data: {
          maxSupply: BigInt('1000000000000'),
          circulatingSupply: BigInt('500000000'),
          reservedSupply: BigInt('100000000'),
          treasuryBalance: BigInt('400000000'),
          isFrozen: false,
        },
      });
    }

    return {
      id: reserve.id,
      maxSupply: reserve.maxSupply.toString(),
      circulatingSupply: reserve.circulatingSupply.toString(),
      reservedSupply: reserve.reservedSupply.toString(),
      treasuryBalance: reserve.treasuryBalance.toString(),
      isFrozen: reserve.isFrozen,
      updatedAt: reserve.updatedAt,
    };
  }

  /**
   * Returns global treasury balance summary metrics
   */
  async getTreasurySummary() {
    const reserve = await this.getTreasuryReserve();
    return {
      treasuryBalance: reserve.treasuryBalance,
      reservedSupply: reserve.reservedSupply,
      circulatingSupply: reserve.circulatingSupply,
      maxSupply: reserve.maxSupply,
      isFrozen: reserve.isFrozen,
      lastUpdated: reserve.updatedAt,
    };
  }
}
