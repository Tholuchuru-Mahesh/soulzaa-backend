import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CosmeticType, WealthBenefitType, WealthLevelBenefit } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import { WealthRepository } from '../repositories/wealth.repository';
import { WealthLevelService } from './wealth-level.service';

/** Grantable benefit types map to the catalog cosmetic type backing them. */
const GRANTABLE_BENEFIT_TYPE_TO_COSMETIC_TYPE: Partial<Record<WealthBenefitType, CosmeticType>> = {
  PROFILE_FRAME: 'FRAME',
  THEME: 'THEME',
  PROFILE_THEME: 'THEME',
  ENTRANCE_ANIMATION: 'ENTRANCE_EFFECT',
  BADGE: 'BADGE',
};

/**
 * Super Admin management surface: levels, benefits, generic configuration.
 * Every mutation writes a `WealthAudit` row (actor, before, after) and forces
 * the in-memory `WealthLevelService` cache to reload so the change is visible
 * on the very next request, not after the 5-minute timer.
 */
@Injectable()
export class WealthAdminService {
  constructor(
    private readonly repo: WealthRepository,
    private readonly levels: WealthLevelService,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
  ) {}

  /**
   * Grantable benefit types (frame/room theme/entrance effect/badge/gold
   * coins) must reference a real, enabled catalog cosmetic of the matching
   * type (or a positive coin amount) — mirrors
   * `TreasureAdminService.resolveRewards`'s validation so a benefit can never
   * be configured to grant a dead/disabled/mismatched cosmetic. Every other
   * (legacy, passive) benefit type is untouched — free-form `config` JSON,
   * no cosmetic/coin fields, no claim.
   */
  private async validateGrantable(input: {
    benefitType: WealthBenefitType;
    cosmeticId?: string | null;
    coinAmount?: number | null;
  }): Promise<void> {
    if (input.benefitType === 'GOLD_COINS') {
      if (!input.coinAmount || input.coinAmount <= 0) {
        throw new BusinessException(
          ERROR_CODES.VALIDATION_ERROR,
          'A GOLD_COINS benefit needs a positive coinAmount.',
          HttpStatus.BAD_REQUEST,
        );
      }
      return;
    }
    const expectedCosmeticType = GRANTABLE_BENEFIT_TYPE_TO_COSMETIC_TYPE[input.benefitType];
    if (!expectedCosmeticType) return; // legacy passive perk — nothing to validate
    if (!input.cosmeticId) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        `A ${input.benefitType} benefit needs a cosmeticId.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const cosmetic = await this.cosmetics.getCosmetic(input.cosmeticId);
    if (!cosmetic || !cosmetic.enabled) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'The selected cosmetic does not exist or is disabled.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (cosmetic.type !== expectedCosmeticType) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        `"${cosmetic.name}" is a ${cosmetic.type}, not a ${expectedCosmeticType}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Equippable benefits carry a `cosmeticId` — the actual image rendered
   * wherever that cosmetic is equipped comes from the Cosmetic catalog's own
   * `mediaUrl`, not this benefit's `iconUrl` (that's only the small icon
   * shown in admin/level listings). Without this, an admin-uploaded icon
   * never reaches the real equipped visual.
   */
  private async syncCosmeticMedia(benefit: WealthLevelBenefit): Promise<void> {
    if (!benefit.cosmeticId || !benefit.iconUrl) return;
    await this.cosmetics.setMedia(benefit.cosmeticId, benefit.iconUrl);
  }

  /** All tiers (including inactive) — the Super Admin management view. */
  async listLevels() {
    return this.repo.listAllLevels();
  }

  /** The next free ordinal for "+ Add level" — mirrors how a new gift/cosmetic gets an auto-assigned id. */
  async nextLevelOrdinal(): Promise<number> {
    return this.repo.nextLevelOrdinal();
  }

  async upsertLevel(
    actorId: string,
    level: number,
    data: {
      name: string;
      expThreshold: number;
      isActive?: boolean;
      iconUrl?: string | null;
      backgroundUrl?: string | null;
    },
  ) {
    const previous = await this.repo.getLevel(level);
    const updated = await this.repo.upsertLevel(level, {
      name: data.name,
      expThreshold: BigInt(data.expThreshold),
      isActive: data.isActive,
      iconUrl: data.iconUrl,
      backgroundUrl: data.backgroundUrl,
    });
    await this.repo.writeAudit({
      actorId,
      action: previous ? 'WEALTH_LEVEL_UPDATED' : 'WEALTH_LEVEL_CREATED',
      entityType: 'WealthLevel',
      entityId: updated.id,
      oldValue: previous,
      newValue: updated,
    });
    await this.levels.reload();
    return updated;
  }

  // ---- Benefit categories ----
  // Purely a browse-time grouping — see WealthBenefitCategory in wealth.prisma.
  // Every mutation is audited the same way levels/benefits are.

  async listCategories() {
    return this.repo.listAllCategories();
  }

  async createCategory(actorId: string, input: { level: number; name: string; iconUrl?: string | null; isActive?: boolean }) {
    const created = await this.repo.createCategory(input);
    await this.repo.writeAudit({
      actorId,
      action: 'WEALTH_BENEFIT_CATEGORY_CREATED',
      entityType: 'WealthBenefitCategory',
      entityId: created.id,
      newValue: created,
    });
    return created;
  }

  async updateCategory(
    actorId: string,
    id: string,
    input: Partial<{ name: string; iconUrl: string | null; isActive: boolean }>,
  ) {
    const previous = await this.repo.getCategory(id);
    if (!previous) {
      throw new BusinessException(ERROR_CODES.VALIDATION_ERROR, 'Category not found.', HttpStatus.NOT_FOUND);
    }
    const updated = await this.repo.updateCategory(id, input);
    await this.repo.writeAudit({
      actorId,
      action: 'WEALTH_BENEFIT_CATEGORY_UPDATED',
      entityType: 'WealthBenefitCategory',
      entityId: id,
      oldValue: previous,
      newValue: updated,
    });
    return updated;
  }

  /**
   * A benefit's `categoryId`, if set, must belong to the same level as the
   * benefit — otherwise a category built for Level 2 could silently end up
   * displaying a Level 1 reward inside it (or vice versa).
   */
  private async validateCategoryOwnership(level: number, categoryId?: string | null): Promise<void> {
    if (!categoryId) return;
    const category = await this.repo.getCategory(categoryId);
    if (!category) {
      throw new BusinessException(ERROR_CODES.VALIDATION_ERROR, 'Category not found.', HttpStatus.BAD_REQUEST);
    }
    if (category.level !== level) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        `"${category.name}" belongs to level ${category.level}, not level ${level}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async listBenefits() {
    return this.repo.listBenefits();
  }

  async createBenefit(
    actorId: string,
    input: {
      level: number;
      categoryId?: string | null;
      benefitType: WealthBenefitType;
      config: unknown;
      cosmeticId?: string | null;
      coinAmount?: number | null;
      durationDays?: number | null;
      isActive?: boolean;
      iconUrl?: string | null;
    },
  ) {
    await this.validateGrantable(input);
    await this.validateCategoryOwnership(input.level, input.categoryId);
    const created = await this.repo.createBenefit(input);
    await this.syncCosmeticMedia(created);
    await this.repo.writeAudit({
      actorId,
      action: 'WEALTH_BENEFIT_CREATED',
      entityType: 'WealthLevelBenefit',
      entityId: created.id,
      newValue: created,
    });
    return created;
  }

  async updateBenefit(
    actorId: string,
    id: string,
    input: Partial<{
      categoryId: string | null;
      benefitType: WealthBenefitType;
      config: unknown;
      cosmeticId: string | null;
      coinAmount: number | null;
      durationDays: number | null;
      isActive: boolean;
      iconUrl: string | null;
    }>,
  ) {
    const existing = await this.repo.getBenefit(id);
    if (!existing) {
      throw new BusinessException(ERROR_CODES.VALIDATION_ERROR, 'Benefit not found.', HttpStatus.NOT_FOUND);
    }
    if (input.benefitType !== undefined || input.cosmeticId !== undefined || input.coinAmount !== undefined) {
      await this.validateGrantable({
        benefitType: input.benefitType ?? existing.benefitType,
        cosmeticId: input.cosmeticId !== undefined ? input.cosmeticId : existing.cosmeticId,
        coinAmount: input.coinAmount !== undefined ? input.coinAmount : existing.coinAmount,
      });
    }
    if (input.categoryId !== undefined) {
      await this.validateCategoryOwnership(existing.level, input.categoryId);
    }
    const updated = await this.repo.updateBenefit(id, input);
    if (input.iconUrl !== undefined) {
      await this.syncCosmeticMedia(updated);
    }
    await this.repo.writeAudit({
      actorId,
      action: 'WEALTH_BENEFIT_UPDATED',
      entityType: 'WealthLevelBenefit',
      entityId: id,
      newValue: updated,
    });
    return updated;
  }

  async getConfiguration() {
    return this.repo.listConfiguration();
  }

  async updateConfiguration(actorId: string, key: string, value: unknown) {
    const previous = await this.repo.getConfiguration(key);
    const updated = await this.repo.upsertConfiguration(key, value, actorId);
    await this.repo.writeAudit({
      actorId,
      action: 'WEALTH_CONFIGURATION_UPDATED',
      entityType: 'WealthConfiguration',
      entityId: key,
      oldValue: previous,
      newValue: updated,
    });
    return updated;
  }

  async listAudit(page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [rows, total] = await this.repo.listAudit(skip, limit);
    return buildPaginated(rows, total, page, limit);
  }
}
