import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AchievementAuditService } from './achievement-audit.service';
import { AchievementEventService } from './achievement-event.service';
import { AchievementValidationService } from './achievement-validation.service';

export interface CreateBadgeInput {
  code: string;
  name: string;
  description?: string;
  tier?: string;
  badgeType?: string;
  iconUrl?: string;
  animationUrl?: string;
  rarity?: string;
  season?: string;
  expiresAt?: Date;
  actorId?: string;
}

@Injectable()
export class BadgeService {
  private readonly logger = new Logger(BadgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: AchievementValidationService,
    private readonly auditService: AchievementAuditService,
    private readonly eventService: AchievementEventService,
  ) {}

  async createBadge(input: CreateBadgeInput) {
    return this.prisma.badgeDefinition.create({
      data: {
        code: input.code,
        name: input.name,
        description: input.description,
        tier: input.tier ?? 'BRONZE',
        badgeType: input.badgeType ?? 'STANDARD',
        iconUrl: input.iconUrl,
        animationUrl: input.animationUrl,
        rarity: input.rarity ?? 'COMMON',
        season: input.season,
        expiresAt: input.expiresAt,
      },
    });
  }

  async getBadgeDefinitions(tier?: string, badgeType?: string) {
    const where: any = { status: 'ACTIVE' };
    if (tier) where.tier = tier;
    if (badgeType) where.badgeType = badgeType;
    return this.prisma.badgeDefinition.findMany({ where, orderBy: { name: 'asc' } });
  }

  async getBadgeDefinition(code: string) {
    return this.validationService.validateBadgeExists(code);
  }

  async getUserBadges(userId: string) {
    return this.prisma.badgeInventory.findMany({
      where: { userId },
      include: { badge: true },
      orderBy: { acquiredAt: 'desc' },
    });
  }

  async getUserEquippedBadge(userId: string) {
    return this.prisma.badgeInventory.findFirst({
      where: { userId, equipped: true },
      include: { badge: true },
    });
  }

  async equipBadge(userId: string, badgeCode: string, actorId?: string) {
    await this.validationService.validateUserHasBadge(userId, badgeCode);

    // Unequip any currently equipped badge
    await this.prisma.badgeInventory.updateMany({
      where: { userId, equipped: true },
      data: { equipped: false, equippedAt: null },
    });

    const updated = await this.prisma.badgeInventory.update({
      where: { userId_badgeCode: { userId, badgeCode } },
      data: { equipped: true, equippedAt: new Date() },
      include: { badge: true },
    });

    await this.auditService.logAudit('BADGE_EQUIPPED', userId, actorId, { badgeCode });
    await this.eventService.publishBadgeEquipped(userId, badgeCode);

    return updated;
  }

  async unequipBadge(userId: string, badgeCode: string, actorId?: string) {
    await this.validationService.validateUserHasBadge(userId, badgeCode);

    const updated = await this.prisma.badgeInventory.update({
      where: { userId_badgeCode: { userId, badgeCode } },
      data: { equipped: false, equippedAt: null },
    });

    await this.auditService.logAudit('BADGE_UNEQUIPPED', userId, actorId, { badgeCode });
    await this.eventService.publishBadgeUnequipped(userId, badgeCode);

    return updated;
  }

  async adminGrantBadge(userId: string, badgeCode: string, actorId: string) {
    await this.validationService.validateUserExists(userId);
    await this.validationService.validateBadgeExists(badgeCode);

    const inv = await this.prisma.badgeInventory.upsert({
      where: { userId_badgeCode: { userId, badgeCode } },
      update: {},
      create: { userId, badgeCode, source: 'ADMIN_GRANT', sourceRefId: actorId },
    });

    await this.auditService.logAudit('BADGE_UNLOCKED', userId, actorId, {
      badgeCode,
      source: 'ADMIN_GRANT',
    });
    await this.eventService.publishBadgeUnlocked(userId, badgeCode);

    return inv;
  }
}
