import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class AchievementValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async validateUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
  }

  async validateAchievementExists(achievementId: string) {
    const def = await this.prisma.achievementDefinition.findUnique({
      where: { id: achievementId },
    });
    if (!def) {
      throw new NotFoundException(`Achievement ${achievementId} not found`);
    }
    if (def.status !== 'ACTIVE') {
      throw new BadRequestException(`Achievement ${achievementId} is not active`);
    }
    return def;
  }

  async validateAchievementByCode(code: string) {
    const def = await this.prisma.achievementDefinition.findUnique({ where: { code } });
    if (!def) {
      throw new NotFoundException(`Achievement with code '${code}' not found`);
    }
    if (def.status !== 'ACTIVE') {
      throw new BadRequestException(`Achievement '${code}' is not active`);
    }
    return def;
  }

  async validateBadgeExists(badgeCode: string) {
    const badge = await this.prisma.badgeDefinition.findUnique({ where: { code: badgeCode } });
    if (!badge) {
      throw new NotFoundException(`Badge '${badgeCode}' not found`);
    }
    if (badge.status !== 'ACTIVE') {
      throw new BadRequestException(`Badge '${badgeCode}' is not active`);
    }
    return badge;
  }

  async validateNotAlreadyUnlocked(
    userId: string,
    achievementId: string,
    repeatable: boolean,
  ): Promise<void> {
    if (repeatable) return; // Repeatable achievements can be awarded multiple times
    const existing = await this.prisma.userAchievement.findFirst({
      where: { userId, achievementId },
    });
    if (existing) {
      throw new BadRequestException(
        `User ${userId} has already unlocked achievement ${achievementId}`,
      );
    }
  }

  async validateRewardEligibility(userId: string, achievementId: string): Promise<void> {
    const unlock = await this.prisma.userAchievement.findFirst({
      where: { userId, achievementId },
    });
    if (!unlock) {
      throw new BadRequestException('Achievement has not been unlocked');
    }
    if (unlock.rewardClaimed) {
      throw new BadRequestException('Reward has already been claimed');
    }
  }

  validateProgressAmount(amount: number): void {
    if (!Number.isInteger(amount) || amount < 1) {
      throw new BadRequestException('Progress amount must be a positive integer');
    }
  }

  async validateUserHasBadge(userId: string, badgeCode: string) {
    const inv = await this.prisma.badgeInventory.findUnique({
      where: { userId_badgeCode: { userId, badgeCode } },
    });
    if (!inv) {
      throw new BadRequestException(`User does not own badge '${badgeCode}'`);
    }
    return inv;
  }
}
