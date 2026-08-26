import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { WealthExpSourceType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { currentPeriodKey, wealthLockKey } from '../constants/wealth.constants';
import { WealthLevelUpEvent } from '../events/wealth.events';
import { WealthRepository } from '../repositories/wealth.repository';
import { WealthLevelService } from './wealth-level.service';
import { WealthRewardService } from './wealth-reward.service';

export interface WealthAwardInput {
  userId: string;
  /** Positive integer — the full wallet credit (paid + bonus coins). */
  amount: number;
  sourceRef: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface WealthAwardResult {
  currentExp: number;
  currentLevel: number;
  leveledUp: boolean;
}

export interface WealthReverseInput {
  userId: string;
  /** The purchase order id being refunded/charged back — same as the original award's sourceRef. */
  sourceRef: string;
  amount: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

/**
 * The ONLY entry point that ever changes a user's Wealth Level EXP.
 * `award` is idempotent on `idempotencyKey` (a DB-unique constraint on
 * `WealthExpLedger`), under a per-user lock so concurrent purchases can't
 * race the level recompute. EXP is monthly — awards always land in the
 * *current* calendar month regardless of when the underlying purchase event
 * is processed, so a delayed webhook never retroactively edits a closed
 * month (see WealthMonthlyHistory).
 */
@Injectable()
export class WealthExpLedgerService {
  private readonly logger = new Logger(WealthExpLedgerService.name);

  constructor(
    private readonly repo: WealthRepository,
    private readonly levels: WealthLevelService,
    private readonly rewards: WealthRewardService,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async award(input: WealthAwardInput): Promise<WealthAwardResult> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BusinessException(
        ERROR_CODES.INVALID_AMOUNT,
        'Wealth EXP amount must be a positive integer.',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.locks.withLock(wealthLockKey(input.userId), async () => {
      const existing = await this.repo.findLedgerByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        const progress = await this.repo.getProgress(input.userId);
        return {
          currentExp: Number(progress?.currentExp ?? 0n),
          currentLevel: progress?.currentLevel ?? 0,
          leveledUp: false,
        };
      }

      const periodKey = currentPeriodKey();
      const progress = await this.repo.getProgress(input.userId);

      // A user's live progress row is only ever for the current month — the
      // monthly reset job rewrites it at rollover. If it's stale (reset
      // hasn't run yet for some reason), treat exp as starting fresh this
      // month; the effective level floor is still whatever the row says.
      const isCurrentMonth = progress?.periodKey === periodKey;
      const baseExp = isCurrentMonth ? (progress?.currentExp ?? 0n) : 0n;
      const oldLevel = progress?.currentLevel ?? 0;

      const newExp = baseExp + BigInt(input.amount);
      const expDerivedLevel = this.levels.levelForExp(newExp);
      const newLevel = Math.max(oldLevel, expDerivedLevel);

      await this.repo.applyAward({
        userId: input.userId,
        amount: BigInt(input.amount),
        sourceType: WealthExpSourceType.GOLD_COIN_PURCHASE,
        sourceRef: input.sourceRef,
        idempotencyKey: input.idempotencyKey,
        periodKey,
        newLevel,
        metadata: input.metadata as never,
      });

      const leveledUp = newLevel > oldLevel;
      if (leveledUp) {
        await this.rewards.grantAutomaticForCrossedLevels(
          input.userId,
          oldLevel,
          newLevel,
          periodKey,
        );
        await this.bus.publish(
          new WealthLevelUpEvent({
            userId: input.userId,
            fromLevel: oldLevel,
            toLevel: newLevel,
            currentExp: Number(newExp),
            periodKey,
          }),
        );
      }

      return { currentExp: Number(newExp), currentLevel: newLevel, leveledUp };
    });
  }

  /**
   * Reverses a purchase's EXP for a refund/chargeback. Idempotent on its own
   * `idempotencyKey`. Never reverses more than what remains outstanding for
   * that purchase (`netAwardedForSourceRef`), and only mutates *live*
   * progress if the original award is still in the current month — an
   * already-closed month's history is immutable per policy.
   */
  async reverse(input: WealthReverseInput): Promise<void> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BusinessException(
        ERROR_CODES.INVALID_AMOUNT,
        'Wealth EXP reversal amount must be a positive integer.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.locks.withLock(wealthLockKey(input.userId), async () => {
      const existing = await this.repo.findLedgerByIdempotencyKey(input.idempotencyKey);
      if (existing) return;

      const netOutstanding = await this.repo.netAwardedForSourceRef(input.sourceRef);
      const reverseAmount =
        BigInt(input.amount) > netOutstanding ? netOutstanding : BigInt(input.amount);
      if (reverseAmount <= 0n) {
        this.logger.warn(
          `Wealth EXP reversal for sourceRef=${input.sourceRef} has nothing outstanding to reverse; recording a zero-impact audit entry.`,
        );
      }

      const periodKey = currentPeriodKey();
      const progress = await this.repo.getProgress(input.userId);
      const isCurrentMonth = progress?.periodKey === periodKey;

      let newExp: bigint | null = null;
      let newLevel: number | null = null;
      if (isCurrentMonth && reverseAmount > 0n) {
        newExp = (progress?.currentExp ?? 0n) - reverseAmount;
        if (newExp < 0n) newExp = 0n;
        newLevel = this.levels.levelForExp(newExp);
      }

      await this.repo.applyReversal({
        userId: input.userId,
        amount: reverseAmount > 0n ? reverseAmount : BigInt(input.amount),
        sourceRef: input.sourceRef,
        idempotencyKey: input.idempotencyKey,
        periodKey,
        newExp,
        newLevel,
        metadata: input.metadata as never,
      });
    });
  }
}
