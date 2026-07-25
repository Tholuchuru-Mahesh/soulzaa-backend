import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { AgencyRelationshipService } from './agency-relationship.service';

@Injectable()
export class AgencyValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coinEconomyService: CoinEconomyService,
    private readonly relationshipService: AgencyRelationshipService,
  ) {}

  /**
   * Validates pre-conditions before executing agency settlement.
   */
  async validateSettlement(revenueDistributionId: string, hostId: string) {
    // 1. Check Treasury Economy Freeze
    const isFrozen = await this.coinEconomyService.isEconomyFrozen();
    if (isFrozen) {
      throw new ForbiddenException('Agency settlement suspended due to Treasury Economy Freeze');
    }

    // 2. Check Idempotency / Replay protection
    const existing = await this.prisma.agencySettlement.findUnique({
      where: { revenueDistributionId },
    });
    if (existing) {
      return { isDuplicate: true, existingSettlement: existing, relationship: null };
    }

    // 3. Validate active Agency-Host relationship
    const relationship = await this.relationshipService.getActiveAgencyForHost(hostId);
    if (!relationship) {
      // Independent host not affiliated with any active agency
      return { isDuplicate: false, existingSettlement: null, relationship: null };
    }

    // 4. Validate Agency account status
    const agencyUser = await this.prisma.user.findUnique({
      where: { id: relationship.agencyId },
      select: { id: true, status: true },
    });

    if (!agencyUser || agencyUser.status === 'BANNED' || agencyUser.status === 'SUSPENDED') {
      throw new ForbiddenException(`Agency account '${relationship.agencyId}' is not active`);
    }

    return { isDuplicate: false, existingSettlement: null, relationship };
  }
}
