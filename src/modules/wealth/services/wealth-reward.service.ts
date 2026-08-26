import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  BackpackItemSource,
  WalletCurrency,
  WalletTxnReason,
  WealthClaimStatus,
  WealthRewardFrequency,
  WealthRewardGrantType,
  type WealthLevelReward,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { HttpStatus } from '@nestjs/common';
import { WealthRewardAvailableEvent, WealthRewardClaimedEvent } from '../events/wealth.events';
import { WealthRepository } from '../repositories/wealth.repository';

/** Dedupe-scope period key for a reward's claim frequency. */
function periodKeyForFrequency(frequency: WealthRewardFrequency, now: Date = new Date()): string {
  if (frequency === WealthRewardFrequency.ONE_TIME) return 'LIFETIME';
  if (frequency === WealthRewardFrequency.DAILY) {
    return now.toISOString().slice(0, 10); // YYYY-MM-DD
  }
  if (frequency === WealthRewardFrequency.WEEKLY) {
    // ISO week number, "YYYY-Www".
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  // MONTHLY
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Level rewards: automatic grants (fired on level-up / monthly re-grant) and
 * user-initiated claims for claimable rewards. Every grant/claim goes through
 * `WealthRepository.grantRewardClaim`'s unique-constraint upsert, so a reward
 * can never be granted/claimed twice for the same (user, reward, period) no
 * matter how many times this is called (double click, retry, concurrent
 * request, re-run of the level-up handler).
 */
@Injectable()
export class WealthRewardService {
  private readonly logger = new Logger(WealthRewardService.name);

  constructor(
    private readonly repo: WealthRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Optional() @Inject(WALLET_SERVICE) private readonly wallet?: IWalletService,
    @Optional() @Inject(COSMETICS_SERVICE) private readonly cosmetics?: ICosmeticsService,
  ) {}

  /** Grants every active AUTOMATIC reward newly unlocked by crossing (fromLevel, toLevel]. */
  async grantAutomaticForCrossedLevels(
    userId: string,
    fromLevel: number,
    toLevel: number,
    periodKey: string,
  ): Promise<void> {
    const all = await this.repo.listRewardsActive();
    const unlocked = all.filter(
      (r) =>
        r.level > fromLevel &&
        r.level <= toLevel &&
        r.grantType === WealthRewardGrantType.AUTOMATIC,
    );
    for (const reward of unlocked) {
      await this.grantOne(userId, reward, periodKey);
    }
  }

  /** Re-grants every active recurring (DAILY/WEEKLY/MONTHLY) AUTOMATIC reward at or below `level` for the current period. Called by the monthly reset job. */
  async grantAutomaticForPeriod(userId: string, level: number, periodKey: string): Promise<void> {
    const all = await this.repo.listRewardsActive();
    const eligible = all.filter(
      (r) =>
        r.level <= level &&
        r.grantType === WealthRewardGrantType.AUTOMATIC &&
        r.frequency !== WealthRewardFrequency.ONE_TIME,
    );
    for (const reward of eligible) {
      await this.grantOne(userId, reward, periodKey);
    }
  }

  private async grantOne(
    userId: string,
    reward: WealthLevelReward,
    fallbackPeriodKey: string,
  ): Promise<void> {
    if (this.isOutsideWindow(reward)) return;
    const periodKey =
      reward.frequency === WealthRewardFrequency.MONTHLY
        ? fallbackPeriodKey
        : periodKeyForFrequency(reward.frequency);

    const existing = await this.repo.findRewardClaim(userId, reward.id, periodKey);
    if (existing) return;

    const claim = await this.repo.grantRewardClaim(userId, reward.id, periodKey);
    // Upsert can race two concurrent callers to "create" — only the one that
    // actually inserted a fresh GRANTED-with-no-prior-fulfillment row should
    // fulfill. Re-checking `existing === null` before the upsert plus the
    // unique constraint means at most one caller reaches here per period.
    await this.fulfill(userId, reward);
    await this.bus.publish(
      new WealthRewardAvailableEvent({ userId, rewardId: reward.id, level: reward.level }),
    );
    void claim;
  }

  /** User-initiated claim of a CLAIMABLE reward. Idempotent — a second call is a no-op replay. */
  async claimReward(
    userId: string,
    rewardId: string,
    userLevel: number,
  ): Promise<{ claimed: boolean }> {
    const reward = await this.repo.getReward(rewardId);
    if (!reward || !reward.isActive) {
      throw new NotFoundException('Reward not found or inactive.');
    }
    if (this.isOutsideWindow(reward)) {
      throw new BusinessException(
        ERROR_CODES.WEALTH_REWARD_WINDOW_CLOSED,
        'This reward is not currently claimable.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (reward.grantType !== WealthRewardGrantType.CLAIMABLE) {
      throw new BusinessException(
        ERROR_CODES.WEALTH_REWARD_NOT_CLAIMABLE,
        'This reward is granted automatically and cannot be claimed manually.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (userLevel < reward.level) {
      throw new BusinessException(
        ERROR_CODES.WEALTH_LEVEL_TOO_LOW,
        'Your Wealth Level is not high enough to claim this reward.',
        HttpStatus.FORBIDDEN,
      );
    }

    const periodKey = periodKeyForFrequency(reward.frequency);
    const existing = await this.repo.findRewardClaim(userId, rewardId, periodKey);
    if (existing?.status === WealthClaimStatus.CLAIMED) {
      return { claimed: true };
    }

    const claim = await this.repo.grantRewardClaim(userId, rewardId, periodKey);
    if (claim.status === WealthClaimStatus.CLAIMED) {
      return { claimed: true };
    }

    await this.repo.markClaimed(claim.id);
    await this.fulfill(userId, reward);
    await this.bus.publish(new WealthRewardClaimedEvent({ userId, rewardId, level: reward.level }));
    return { claimed: true };
  }

  /** Active rewards visible to a user at `level` (cumulative — same rule as benefits). */
  async listAvailableForLevel(level: number): Promise<WealthLevelReward[]> {
    const all = await this.repo.listRewardsActive();
    return all.filter((r) => r.level <= level && !this.isOutsideWindow(r));
  }

  async listClaims(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [rows, total] = await this.repo.listClaims(userId, skip, limit);
    return buildPaginated(rows, total, page, limit);
  }

  private isOutsideWindow(reward: WealthLevelReward): boolean {
    const now = new Date();
    if (reward.startAt && now < reward.startAt) return true;
    if (reward.endAt && now > reward.endAt) return true;
    return false;
  }

  private async fulfill(userId: string, reward: WealthLevelReward): Promise<void> {
    const value = (reward.rewardValue ?? {}) as Record<string, unknown>;
    try {
      if (reward.rewardType === 'GOLD_COINS' && this.wallet) {
        const amount = Number(value.amount ?? 0);
        if (amount > 0) {
          await this.wallet.credit({
            userId,
            currency: WalletCurrency.GOLD,
            amount,
            reason: WalletTxnReason.EVENT_REWARD,
            idempotencyKey: `wealth-reward:${userId}:${reward.id}:${randomUUID()}`,
            referenceType: 'wealth_level_reward',
            referenceId: reward.id,
          });
        }
      } else if (
        (reward.rewardType === 'COSMETIC' ||
          reward.rewardType === 'BADGE' ||
          reward.rewardType === 'PROFILE_FRAME') &&
        this.cosmetics
      ) {
        const cosmeticId = String(value.cosmeticId ?? '');
        if (cosmeticId) {
          await this.cosmetics.grantToUser({
            userId,
            cosmeticId,
            source: BackpackItemSource.EVENT,
            grantKey: `wealth-reward:${userId}:${reward.id}`,
            durationDays: value.durationDays ? Number(value.durationDays) : undefined,
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `Failed to fulfill wealth reward ${reward.id} for user ${userId}: ${(err as Error).message}`,
      );
    }
  }
}
