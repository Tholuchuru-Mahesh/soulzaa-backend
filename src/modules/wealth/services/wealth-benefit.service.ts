import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import type { WealthLevelBenefit } from '@prisma/client';
import { BackpackItemSource } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import { WealthRepository } from '../repositories/wealth.repository';

export interface WealthBenefitView extends WealthLevelBenefit {
  isEquippable: boolean;
  isEquipped: boolean;
}

/**
 * Benefits are cumulative: a user at level N holds every active benefit
 * configured for levels 0..N, not just level N's own (e.g. a Nova user keeps
 * every Prestige + Rise benefit alongside Nova's). Display-type benefits
 * (badge, frame, ring, theme) are also *equippable* — a benefit is equippable
 * iff its config carries a `cosmeticId`. Equip state itself lives in whichever
 * store the Cosmetics module uses for that cosmetic's type (it hides the
 * frame/theme-vs-badge/decoration storage split), so an equipped benefit
 * shows up everywhere that store is already rendered (profile, chat, rooms)
 * with no extra wiring here.
 */
@Injectable()
export class WealthBenefitService {
  constructor(
    private readonly repo: WealthRepository,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
  ) {}

  async getBenefitsUpToLevel(level: number, userId?: string): Promise<WealthBenefitView[]> {
    const all = await this.repo.listBenefits();
    const eligible = all.filter((b) => b.level <= level).sort((a, b) => a.level - b.level);

    const equippedByCosmeticId = new Map<string, boolean>();
    if (userId) {
      const cosmeticIds = new Set(
        eligible
          .map((b) => this.cosmeticIdOf(b))
          .filter((id): id is string => !!id),
      );
      for (const cosmeticId of cosmeticIds) {
        equippedByCosmeticId.set(cosmeticId, await this.cosmetics.isEquipped(userId, cosmeticId));
      }
    }

    return eligible.map((b) => {
      const cosmeticId = this.cosmeticIdOf(b);
      const isEquippable = !!cosmeticId;
      const isEquipped = cosmeticId ? (equippedByCosmeticId.get(cosmeticId) ?? false) : false;
      return { ...b, isEquippable, isEquipped };
    });
  }

  /** Grants (idempotent) then equips the benefit's cosmetic for the user. */
  async equipBenefit(userId: string, benefitId: string, userLevel: number): Promise<void> {
    const cosmeticId = await this.grantAndGetCosmeticId(userId, benefitId, userLevel);
    await this.cosmetics.equip(userId, cosmeticId);
  }

  /** Unequips the benefit's cosmetic for the user (granting first if somehow missing). */
  async unequipBenefit(userId: string, benefitId: string, userLevel: number): Promise<void> {
    const cosmeticId = await this.grantAndGetCosmeticId(userId, benefitId, userLevel);
    await this.cosmetics.unequip(userId, cosmeticId);
  }

  private cosmeticIdOf(benefit: WealthLevelBenefit): string | undefined {
    return (benefit.config as Record<string, unknown> | null)?.cosmeticId as string | undefined;
  }

  private async grantAndGetCosmeticId(
    userId: string,
    benefitId: string,
    userLevel: number,
  ): Promise<string> {
    const benefit = await this.repo.getBenefit(benefitId);
    if (!benefit || !benefit.isActive) {
      throw new NotFoundException('Benefit not found or inactive.');
    }
    if (benefit.level > userLevel) {
      throw new BusinessException(
        ERROR_CODES.WEALTH_LEVEL_TOO_LOW,
        'Your Wealth Level is not high enough to equip this benefit.',
        HttpStatus.FORBIDDEN,
      );
    }
    const cosmeticId = this.cosmeticIdOf(benefit);
    if (!cosmeticId) {
      throw new BusinessException(
        ERROR_CODES.WEALTH_BENEFIT_NOT_EQUIPPABLE,
        'This benefit is automatically active and cannot be equipped.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const grant = await this.cosmetics.grantToUser({
      userId,
      cosmeticId,
      source: BackpackItemSource.EVENT,
      grantKey: `wealth-benefit:${userId}:${benefit.id}`,
    });
    if (!grant) {
      throw new NotFoundException('The cosmetic backing this benefit is missing or disabled.');
    }
    return cosmeticId;
  }
}
