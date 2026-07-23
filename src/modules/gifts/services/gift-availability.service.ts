import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class GiftAvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates regional and platform availability rules for a gift
   */
  async checkGiftAvailability(
    giftId: string,
    country = 'GLOBAL',
    platform = 'ALL',
  ): Promise<boolean> {
    const gift = await this.prisma.gift.findUnique({ where: { id: giftId } });
    if (!gift || !gift.enabled) return false;

    // Check country restrictions if configured
    if (gift.countryRestriction && gift.countryRestriction.length > 0) {
      if (
        !gift.countryRestriction.includes('GLOBAL') &&
        !gift.countryRestriction.includes(country.toUpperCase())
      ) {
        return false;
      }
    }

    // Check platform restrictions if configured
    if (gift.platformRestriction && gift.platformRestriction.length > 0) {
      if (
        !gift.platformRestriction.includes('ALL') &&
        !gift.platformRestriction.includes(platform.toUpperCase())
      ) {
        return false;
      }
    }

    return true;
  }
}
