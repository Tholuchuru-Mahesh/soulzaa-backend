import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class VipValidationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates VIP tier existence and returns tier object.
   */
  async validateTier(level: number) {
    const tier = await this.prisma.vipTier.findUnique({
      where: { level },
    });
    if (!tier || tier.status !== 'ACTIVE') {
      throw new BadRequestException(`VIP Tier ${level} is not active or does not exist`);
    }
    return tier;
  }

  /**
   * Validates upgrade path: new tier level must be strictly greater than current tier level.
   */
  validateUpgrade(currentLevel: number, targetLevel: number) {
    if (targetLevel <= currentLevel) {
      throw new BadRequestException(
        `Upgrade failed: target tier VIP ${targetLevel} must be higher than current tier VIP ${currentLevel}`,
      );
    }
  }

  /**
   * Validates user membership existence for operations requiring an active VIP.
   */
  async validateActiveMembership(userId: string) {
    const membership = await this.prisma.vipMembership.findUnique({
      where: { userId },
    });
    if (!membership || membership.status !== 'ACTIVE' || membership.expiresAt < new Date()) {
      throw new ForbiddenException('User does not have an active VIP membership');
    }
    return membership;
  }
}
