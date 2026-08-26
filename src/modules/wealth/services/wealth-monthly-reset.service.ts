import { Inject, Injectable, Logger } from '@nestjs/common';
import { WealthResetRunStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  currentPeriodKey,
  previousPeriodKey,
  wealthResetLockKey,
} from '../constants/wealth.constants';
import { WealthDowngradedEvent, WealthMonthlyResetEvent } from '../events/wealth.events';
import { WealthRepository } from '../repositories/wealth.repository';
import { LockService } from 'src/infra/redis/lock.service';
import { WealthDowngradeConfigService } from './wealth-downgrade-config.service';
import { WealthRewardService } from './wealth-reward.service';

export interface WealthResetResult {
  periodKey: string;
  usersProcessed: number;
  skipped: boolean;
}

/**
 * Monthly rollover: closes out the previous month into `WealthMonthlyHistory`
 * (immutable snapshot), computes each user's downgrade floor per the active
 * `WealthDowngradeConfig`, and resets `WealthUserProgress` to
 * (currentExp=0, currentLevel=floor, periodKey=new month).
 *
 * Idempotent at two levels: `WealthMonthlyResetRun` guards the whole batch
 * (a re-run for an already-COMPLETED period is a no-op), and
 * `WealthMonthlyHistory`'s unique (userId, periodKey) constraint guards each
 * user individually — so a crash mid-batch and a safe re-run/retry never
 * double-processes a user or duplicates history/rewards.
 */
@Injectable()
export class WealthMonthlyResetService {
  private readonly logger = new Logger(WealthMonthlyResetService.name);

  constructor(
    private readonly repo: WealthRepository,
    private readonly downgradeConfig: WealthDowngradeConfigService,
    private readonly rewards: WealthRewardService,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  /** Runs the rollover for "now" — closes the previous month, opens the current one. */
  async run(now: Date = new Date()): Promise<WealthResetResult> {
    const newPeriodKey = currentPeriodKey(now);
    const closingPeriodKey = previousPeriodKey(newPeriodKey);

    return this.locks
      .withLock(
        wealthResetLockKey(newPeriodKey),
        () => this.runForPeriod(closingPeriodKey, newPeriodKey),
        { ttlMs: 600_000, retries: 0 },
      )
      .catch((err) => {
        this.logger.warn(`Monthly reset for ${newPeriodKey} skipped: ${(err as Error).message}`);
        return { periodKey: newPeriodKey, usersProcessed: 0, skipped: true };
      });
  }

  private async runForPeriod(
    closingPeriodKey: string,
    newPeriodKey: string,
  ): Promise<WealthResetResult> {
    const existingRun = await this.repo.getResetRun(newPeriodKey);
    if (existingRun?.status === WealthResetRunStatus.COMPLETED) {
      return { periodKey: newPeriodKey, usersProcessed: existingRun.usersProcessed, skipped: true };
    }

    let started = existingRun ? null : await this.repo.tryStartResetRun(newPeriodKey);
    if (!started && existingRun?.status === WealthResetRunStatus.FAILED) {
      await this.repo.restartFailedRun(newPeriodKey);
      started = existingRun;
    }
    if (!started) {
      // Lost the create race to a concurrent instance, or already RUNNING.
      return { periodKey: newPeriodKey, usersProcessed: 0, skipped: true };
    }

    const config = await this.downgradeConfig.getActive();
    const userIds = await this.repo.listAllProgressUserIds();
    let processed = 0;

    try {
      for (const userId of userIds) {
        await this.processUser(userId, closingPeriodKey, newPeriodKey, config);
        processed += 1;
      }
      await this.repo.completeResetRun(newPeriodKey, processed);
      this.logger.log(`Wealth monthly reset completed for ${newPeriodKey}: ${processed} users.`);
      return { periodKey: newPeriodKey, usersProcessed: processed, skipped: false };
    } catch (err) {
      await this.repo.failResetRun(newPeriodKey);
      this.logger.error(
        `Wealth monthly reset for ${newPeriodKey} failed after ${processed} users: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  private async processUser(
    userId: string,
    closingPeriodKey: string,
    newPeriodKey: string,
    config: { enabled: boolean; maxDowngradeLevels: number; minLevel: number },
  ): Promise<void> {
    // Per-user idempotency: a history row already existing for this period
    // means this user was already processed by a prior (possibly crashed)
    // run — never re-derive or overwrite it.
    const alreadyProcessed = await this.repo.getMonthlyHistory(userId, closingPeriodKey);
    if (alreadyProcessed) return;

    const progress = await this.repo.getProgress(userId);
    if (!progress) return;

    const startingLevel = progress.currentLevel;
    const finalExp = progress.currentExp;
    const finalLevel = progress.currentLevel;

    const floor = !config.enabled
      ? startingLevel
      : Math.max(config.minLevel, startingLevel - config.maxDowngradeLevels);

    await this.repo.createMonthlyHistory({
      userId,
      periodKey: closingPeriodKey,
      startingLevel,
      finalExp,
      finalLevel,
      downgradedToLevel: floor,
    });

    await this.repo.resetProgressForNewMonth({ userId, newPeriodKey, floorLevel: floor });

    if (floor < startingLevel) {
      await this.bus.publish(
        new WealthDowngradedEvent({
          userId,
          fromLevel: startingLevel,
          toLevel: floor,
          periodKey: newPeriodKey,
        }),
      );
    }
    await this.bus.publish(
      new WealthMonthlyResetEvent({
        userId,
        previousPeriodKey: closingPeriodKey,
        newPeriodKey,
        startingLevel: floor,
      }),
    );

    await this.rewards.grantAutomaticForPeriod(userId, floor, newPeriodKey);
  }
}
