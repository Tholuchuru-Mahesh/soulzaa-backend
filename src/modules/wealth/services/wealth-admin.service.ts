import { Inject, Injectable } from '@nestjs/common';
import type {
  WealthBenefitType,
  WealthLevelBenefit,
  WealthRewardFrequency,
  WealthRewardGrantType,
  WealthRewardType,
} from '@prisma/client';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import { WealthRepository } from '../repositories/wealth.repository';
import { WealthLevelService } from './wealth-level.service';

/**
 * Super Admin management surface: levels, benefits, rewards, generic
 * configuration. Every mutation writes a `WealthAudit` row (actor, before,
 * after) and forces the in-memory `WealthLevelService` cache to reload so
 * the change is visible on the very next request, not after the 5-minute
 * timer.
 */
@Injectable()
export class WealthAdminService {
  constructor(
    private readonly repo: WealthRepository,
    private readonly levels: WealthLevelService,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
  ) {}

  /**
   * Equippable benefits carry a `cosmeticId` — the actual image rendered
   * wherever that cosmetic is equipped comes from the Cosmetic catalog's own
   * `mediaUrl`, not this benefit's `iconUrl` (that's only the small icon
   * shown in admin/level listings). Without this, an admin-uploaded icon
   * never reaches the real equipped visual.
   */
  private async syncCosmeticMedia(benefit: WealthLevelBenefit): Promise<void> {
    const cosmeticId = (benefit.config as Record<string, unknown> | null)?.cosmeticId as
      string | undefined;
    if (!cosmeticId || !benefit.iconUrl) return;
    await this.cosmetics.setMedia(cosmeticId, benefit.iconUrl);
  }

  async listLevels() {
    return this.repo.listLevels();
  }

  async upsertLevel(
    actorId: string,
    level: number,
    data: {
      name: string;
      expThreshold: number;
      displayOrder?: number;
      isActive?: boolean;
      iconUrl?: string | null;
    },
  ) {
    const previous = await this.repo.getLevel(level);
    const updated = await this.repo.upsertLevel(level, {
      name: data.name,
      expThreshold: BigInt(data.expThreshold),
      displayOrder: data.displayOrder,
      isActive: data.isActive,
      iconUrl: data.iconUrl,
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

  async listBenefits() {
    return this.repo.listBenefits();
  }

  async createBenefit(
    actorId: string,
    input: {
      level: number;
      benefitType: WealthBenefitType;
      config: unknown;
      isActive?: boolean;
      iconUrl?: string | null;
    },
  ) {
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
      benefitType: WealthBenefitType;
      config: unknown;
      isActive: boolean;
      iconUrl: string | null;
    }>,
  ) {
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

  async listRewards() {
    return this.repo.listRewardsActive();
  }

  async createReward(
    actorId: string,
    input: {
      level: number;
      rewardType: WealthRewardType;
      rewardValue: unknown;
      frequency: WealthRewardFrequency;
      grantType: WealthRewardGrantType;
      isActive?: boolean;
      startAt?: Date | null;
      endAt?: Date | null;
    },
  ) {
    const created = await this.repo.createReward(input);
    await this.repo.writeAudit({
      actorId,
      action: 'WEALTH_REWARD_CREATED',
      entityType: 'WealthLevelReward',
      entityId: created.id,
      newValue: created,
    });
    return created;
  }

  async updateReward(
    actorId: string,
    id: string,
    input: Partial<{
      rewardType: WealthRewardType;
      rewardValue: unknown;
      frequency: WealthRewardFrequency;
      grantType: WealthRewardGrantType;
      isActive: boolean;
      startAt: Date | null;
      endAt: Date | null;
    }>,
  ) {
    const previous = await this.repo.getReward(id);
    const updated = await this.repo.updateReward(id, input);
    await this.repo.writeAudit({
      actorId,
      action: 'WEALTH_REWARD_UPDATED',
      entityType: 'WealthLevelReward',
      entityId: id,
      oldValue: previous,
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
