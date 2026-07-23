import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';

@Injectable()
export class RevenueValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coinEconomyService: CoinEconomyService,
  ) {}

  /**
   * Validates pre-conditions before performing revenue distribution.
   */
  async validateRevenueDistribution(giftTxnId: string, hostId: string) {
    // 1. Check Treasury Economy Freeze
    const isFrozen = await this.coinEconomyService.isEconomyFrozen();
    if (isFrozen) {
      throw new ForbiddenException('Revenue distribution suspended due to Treasury Economy Freeze');
    }

    // 2. Check Idempotency / Replay protection (prevent duplicate payouts for same giftTxnId)
    const existing = await this.prisma.revenueDistribution.findUnique({
      where: { giftTxnId },
    });
    if (existing) {
      return { isDuplicate: true, existingDistribution: existing };
    }

    // 3. Check Host Status
    const host = await this.prisma.user.findUnique({
      where: { id: hostId },
      select: { id: true, status: true },
    });

    if (!host) {
      throw new BadRequestException(`Host user '${hostId}' not found`);
    }

    if (host.status === 'BANNED' || host.status === 'SUSPENDED') {
      throw new ForbiddenException(`Host user '${hostId}' is ${host.status}`);
    }

    return { isDuplicate: false, existingDistribution: null };
  }
}
