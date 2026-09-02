import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import type { WealthLevelBenefit } from '@prisma/client';
import { BackpackItemSource } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import {
  RewardFulfillmentEngine,
  type RewardItemPayload,
} from 'src/modules/tasks/services/reward-engine/reward-fulfillment.engine';
import { WealthBenefitClaimedEvent } from '../events/wealth.events';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { WealthRepository } from '../repositories/wealth.repository';

export interface WealthBenefitView extends WealthLevelBenefit {
  isEquippable: boolean;
  isEquipped: boolean;
  isClaimable: boolean;
  isClaimed: boolean;
  cosmetic?: {
    id: string;
    name: string;
    type: string;
    mediaUrl: string | null;
    thumbnailUrl: string | null;
    rarity: string | null;
  } | null;
}

/**
 * Maps a grantable `benefitType` to the reward-item shape `RewardFulfillmentEngine`
 * expects. VIP benefit cosmetics are never transferable/giftable, regardless of the
 * backing catalog cosmetic's own `transferable` flag.
 */
function toRewardItem(benefit: WealthLevelBenefit): RewardItemPayload {
  const durationDays = benefit.durationDays ?? undefined;
  const transferable = false;
  switch (benefit.benefitType) {
    case 'PROFILE_FRAME':
      return { type: 'FRAME', cosmeticId: benefit.cosmeticId!, durationDays, transferable };
    case 'THEME':
    case 'PROFILE_THEME':
      return { type: 'THEME', cosmeticId: benefit.cosmeticId!, durationDays, transferable };
    case 'ENTRANCE_ANIMATION':
      return { type: 'ENTRANCE_EFFECT', cosmeticId: benefit.cosmeticId!, durationDays, transferable };
    case 'BADGE':
      return { type: 'BADGE', cosmeticId: benefit.cosmeticId!, durationDays, transferable };
    case 'GOLD_COINS':
      return { type: 'GOLD', amount: benefit.coinAmount ?? 0 };
    default:
      throw new BusinessException(
        ERROR_CODES.WEALTH_BENEFIT_NOT_CLAIMABLE,
        'This benefit is automatically active and cannot be claimed.',
        HttpStatus.BAD_REQUEST,
      );
  }
}

/**
 * Benefits are cumulative: a user at level N holds every active benefit
 * configured for levels 0..N, not just level N's own (e.g. a Nova user keeps
 * every Prestige + Rise benefit alongside Nova's). Grantable benefits (frame,
 * room theme, entrance effect, badge, gold coins — carrying `cosmeticId` and/or
 * `coinAmount`) must be *claimed* first — claiming routes through the exact
 * same `RewardFulfillmentEngine` daily tasks use, depositing into the same
 * `RewardFulfillmentEngine` daily tasks use, depositing into the same
 * Backpack/UserCosmetic tables. Legacy passive perks (every other
 * `benefitType`) stay automatically active with no claim, exactly as before.
 * Equip state lives in whichever store the Cosmetics module uses for that
 * cosmetic's type, so an equipped benefit shows up everywhere that store is
 * already rendered (profile, chat, rooms) with no extra wiring here.
 */
@Injectable()
export class WealthBenefitService {
  constructor(
    private readonly repo: WealthRepository,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
    private readonly rewardEngine: RewardFulfillmentEngine,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async getBenefitsUpToLevel(level: number, userId?: string): Promise<WealthBenefitView[]> {
    const all = await this.repo.listBenefits();
    const eligible = all.filter((b) => b.level <= level).sort((a, b) => a.level - b.level);

    const equippedByCosmeticId = new Map<string, boolean>();
    const claimedByBenefitId = new Set<string>();
    const cosmeticById = new Map<string, any>();

    const cosmeticIds = new Set(
      eligible.map((b) => b.cosmeticId).filter((id): id is string => !!id),
    );

    for (const cosmeticId of cosmeticIds) {
      if (userId) {
        equippedByCosmeticId.set(cosmeticId, await this.cosmetics.isEquipped(userId, cosmeticId));
      }
      const cosmetic = await this.cosmetics.getCosmetic(cosmeticId);
      if (cosmetic) {
        cosmeticById.set(cosmeticId, cosmetic);
      }
    }

    if (userId) {
      const claims = await this.repo.listBenefitClaimsForUser(userId);
      for (const claim of claims) claimedByBenefitId.add(claim.benefitId);
    }

    return eligible.map((b) => {
      const isClaimable = this.isGrantable(b);
      const isClaimed = claimedByBenefitId.has(b.id);
      // Legacy passive perks (isClaimable=false) are never equippable; a
      // grantable one only becomes equippable once actually claimed.
      const isEquippable = isClaimable && isClaimed;
      const isEquipped = b.cosmeticId ? (equippedByCosmeticId.get(b.cosmeticId) ?? false) : false;
      const cosmetic = b.cosmeticId ? (cosmeticById.get(b.cosmeticId) ?? null) : null;
      const mergedConfig = {
        ...(typeof b.config === 'object' && b.config !== null ? (b.config as Record<string, unknown>) : {}),
        ...(cosmetic ? {
          name: (b.config as any)?.name || cosmetic.name,
          cosmeticId: cosmetic.id,
          cosmeticType: cosmetic.type,
          mediaUrl: cosmetic.mediaUrl,
          thumbnailUrl: cosmetic.thumbnailUrl,
          rarity: cosmetic.rarity,
          transferable: cosmetic.transferable,
        } : {}),
      };

      return {
        ...b,
        config: mergedConfig,
        iconUrl: b.iconUrl || cosmetic?.thumbnailUrl || cosmetic?.mediaUrl || null,
        isEquippable,
        isEquipped,
        isClaimable,
        isClaimed,
        cosmetic: cosmetic ? {
          id: cosmetic.id,
          name: cosmetic.name,
          type: cosmetic.type,
          mediaUrl: cosmetic.mediaUrl,
          thumbnailUrl: cosmetic.thumbnailUrl,
          rarity: cosmetic.rarity,
        } : null,
      };
    });
  }

  private isGrantable(benefit: WealthLevelBenefit): boolean {
    return !!benefit.cosmeticId || !!benefit.coinAmount;
  }

  /**
   * Active benefit categories (display tiles like "Frames", "Entry Effects")
   * across every level — purely a browse-time grouping the client uses to
   * cluster `WealthBenefitView.categoryId` matches under one tappable tile.
   * The reward engine never reads this; claiming still happens per-benefit.
   */
  async getCategories() {
    return this.repo.listCategories();
  }

  /** User-initiated claim of a grantable benefit. Idempotent — a second call is a no-op replay. */
  async claimBenefit(
    userId: string,
    benefitId: string,
    userLevel: number,
  ): Promise<{ claimed: boolean }> {
    const benefit = await this.repo.getBenefit(benefitId);
    if (!benefit || !benefit.isActive) {
      throw new NotFoundException('Benefit not found or inactive.');
    }
    if (!this.isGrantable(benefit)) {
      throw new BusinessException(
        ERROR_CODES.WEALTH_BENEFIT_NOT_CLAIMABLE,
        'This benefit is automatically active and cannot be claimed.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (benefit.level > userLevel) {
      throw new BusinessException(
        ERROR_CODES.WEALTH_LEVEL_TOO_LOW,
        'Your Wealth Level is not high enough to claim this benefit.',
        HttpStatus.FORBIDDEN,
      );
    }

    const existing = await this.repo.findBenefitClaim(userId, benefitId);
    if (existing) {
      return { claimed: true };
    }
    await this.repo.createBenefitClaim(userId, benefitId);

    await this.rewardEngine.fulfillRewards({
      userId,
      rewardDefinition: [toRewardItem(benefit)],
      referenceType: 'event',
      referenceId: benefit.id,
      source: BackpackItemSource.EVENT,
    });
    await this.bus.publish(
      new WealthBenefitClaimedEvent({ userId, benefitId, level: benefit.level }),
    );
    return { claimed: true };
  }

  /** Equips the benefit's cosmetic for the user. The benefit must already be claimed. */
  async equipBenefit(userId: string, benefitId: string, userLevel: number): Promise<void> {
    const cosmeticId = await this.requireClaimedCosmeticId(userId, benefitId, userLevel);
    await this.cosmetics.equip(userId, cosmeticId);
  }

  /** Unequips the benefit's cosmetic for the user. The benefit must already be claimed. */
  async unequipBenefit(userId: string, benefitId: string, userLevel: number): Promise<void> {
    const cosmeticId = await this.requireClaimedCosmeticId(userId, benefitId, userLevel);
    await this.cosmetics.unequip(userId, cosmeticId);
  }

  private async requireClaimedCosmeticId(
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
    if (!benefit.cosmeticId) {
      throw new BusinessException(
        ERROR_CODES.WEALTH_BENEFIT_NOT_EQUIPPABLE,
        'This benefit is automatically active and cannot be equipped.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const claim = await this.repo.findBenefitClaim(userId, benefitId);
    if (!claim) {
      throw new BusinessException(
        ERROR_CODES.WEALTH_BENEFIT_NOT_CLAIMED,
        'Claim this benefit before equipping it.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return benefit.cosmeticId;
  }
}
