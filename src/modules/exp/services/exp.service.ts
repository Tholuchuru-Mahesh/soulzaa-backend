import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventType, ExpSource, LevelConfig, RoomLevelConfig } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { LockService } from 'src/infra/redis/lock.service';
import {
  EVENTS_SERVICE,
  type IEventsService,
} from 'src/modules/events/interfaces/events.service.interface';
import { roomExpLockKey, userExpLockKey, type RewardEntry } from '../constants/exp.constants';
import {
  RoomLeveledUpEvent,
  UserLeveledUpEvent,
  type LevelRewardSummary,
} from '../events/exp.events';
import type { ExpAwardResult, IExpService, UserExpView } from '../interfaces/exp.service.interface';
import { ExpRepository } from '../repositories/exp.repository';
import { ExpRewardGranter } from './exp-reward.granter';

const CONFIG_RELOAD_MS = 300_000;

/**
 * EXP & levels (AR-7). Awards accrue user/room EXP under a per-entity lock, are
 * idempotent on the award key, and auto-level-up when a threshold is crossed —
 * granting every crossed level's rewards (free coins + cosmetics) exactly once
 * and publishing a level-up event. Level ladders are cached in-memory and
 * refreshed on a timer / on admin change so the award hot path never queries
 * config.
 */
@Injectable()
export class ExpService implements IExpService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpService.name);
  private userLevels: LevelConfig[] = [];
  private roomLevels: RoomLevelConfig[] = [];
  private timer: NodeJS.Timeout | null = null;

  private eventsRef: IEventsService | null = null;

  constructor(
    private readonly repo: ExpRepository,
    private readonly granter: ExpRewardGranter,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Resolve the events service lazily to break the exp↔events DI cycle (events
   * grants EXP + gates on level; exp reads the DOUBLE_EXP multiplier). Cached
   * after first lookup. Returns a multiplier of 1 if events is unavailable.
   */
  private async doubleExpMultiplier(): Promise<number> {
    if (!this.eventsRef) {
      try {
        this.eventsRef = this.moduleRef.get<IEventsService>(EVENTS_SERVICE, { strict: false });
      } catch {
        return 1;
      }
    }
    return this.eventsRef.getActiveMultiplier(EventType.DOUBLE_EXP);
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.reload().catch(() => undefined), CONFIG_RELOAD_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reload(): Promise<void> {
    this.userLevels = await this.repo.listLevelConfigs();
    this.roomLevels = await this.repo.listRoomLevelConfigs();
  }

  // ---- IExpService ----

  async award(input: {
    userId: string;
    amount: number;
    source: ExpSource;
    idempotencyKey: string;
    referenceType?: string;
    referenceId?: string;
  }): Promise<ExpAwardResult> {
    this.assertAmount(input.amount);
    return this.locks.withLock(userExpLockKey(input.userId), async () => {
      if (await this.repo.findUserLog(input.idempotencyKey)) {
        const current = await this.repo.getUserExp(input.userId);
        return {
          totalExp: Number(current?.totalExp ?? 0n),
          level: current?.level ?? 1,
          leveledUp: false,
        };
      }

      // Active DOUBLE_EXP events multiply the award.
      const multiplier = await this.doubleExpMultiplier();
      const effectiveAmount = input.amount * multiplier;

      const current = await this.repo.getUserExp(input.userId);
      const oldLevel = current?.level ?? 1;
      const newTotal = (current?.totalExp ?? 0n) + BigInt(effectiveAmount);
      const newLevel = this.levelForExp(newTotal, this.userLevels);

      await this.repo.applyUserExp({
        userId: input.userId,
        amount: effectiveAmount,
        source: input.source,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        idempotencyKey: input.idempotencyKey,
        newLevel,
      });

      let leveledUp = false;
      if (newLevel > oldLevel) {
        leveledUp = true;
        const rewards = await this.grantCrossedLevels(input.userId, oldLevel, newLevel);
        await this.bus.publish(
          new UserLeveledUpEvent({
            userId: input.userId,
            fromLevel: oldLevel,
            toLevel: newLevel,
            totalExp: Number(newTotal),
            rewards,
          }),
        );
      }
      return { totalExp: Number(newTotal), level: newLevel, leveledUp };
    });
  }

  async awardRoom(input: {
    roomId: string;
    amount: number;
    source: ExpSource;
    idempotencyKey: string;
    referenceId?: string;
  }): Promise<ExpAwardResult> {
    this.assertAmount(input.amount);
    return this.locks.withLock(roomExpLockKey(input.roomId), async () => {
      if (await this.repo.findRoomLog(input.idempotencyKey)) {
        const current = await this.repo.getRoomExp(input.roomId);
        return {
          totalExp: Number(current?.totalExp ?? 0n),
          level: current?.level ?? 1,
          leveledUp: false,
        };
      }

      const multiplier = await this.doubleExpMultiplier();
      const effectiveAmount = input.amount * multiplier;

      const current = await this.repo.getRoomExp(input.roomId);
      const oldLevel = current?.level ?? 1;
      const newTotal = (current?.totalExp ?? 0n) + BigInt(effectiveAmount);
      const newLevel = this.levelForExp(newTotal, this.roomLevels);

      await this.repo.applyRoomExp({
        roomId: input.roomId,
        amount: effectiveAmount,
        source: input.source,
        referenceId: input.referenceId ?? null,
        idempotencyKey: input.idempotencyKey,
        newLevel,
      });

      let leveledUp = false;
      if (newLevel > oldLevel) {
        leveledUp = true;
        await this.bus.publish(
          new RoomLeveledUpEvent({
            roomId: input.roomId,
            fromLevel: oldLevel,
            toLevel: newLevel,
            totalExp: Number(newTotal),
          }),
        );
      }
      return { totalExp: Number(newTotal), level: newLevel, leveledUp };
    });
  }

  async getUserExp(userId: string): Promise<UserExpView> {
    const row = await this.repo.getUserExp(userId);
    const totalExp = row?.totalExp ?? 0n;
    const level = row?.level ?? 1;
    return {
      userId,
      totalExp: Number(totalExp),
      level,
      nextLevelExp: this.nextLevelExp(level, this.userLevels),
    };
  }

  // ---- Reads ----

  async history(
    userId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listUserLogs(userId, q.skip, q.limit);
    return buildPaginated(
      rows.map((r) => ({
        id: r.id,
        amount: r.amount,
        source: r.source,
        totalAfter: Number(r.totalAfter),
        createdAt: r.createdAt,
      })),
      total,
      q.page,
      q.limit,
    );
  }

  async getRoomExpView(
    roomId: string,
  ): Promise<{ roomId: string; totalExp: number; level: number }> {
    const row = await this.repo.getRoomExp(roomId);
    return { roomId, totalExp: Number(row?.totalExp ?? 0n), level: row?.level ?? 1 };
  }

  // ---- Internals ----

  private assertAmount(amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BusinessException(
        ERROR_CODES.INVALID_AMOUNT,
        'EXP amount must be a positive integer.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** Highest configured level whose `minExp` ≤ total; defaults to level 1. */
  private levelForExp(total: bigint, configs: { level: number; minExp: bigint }[]): number {
    let level = 1;
    for (const c of configs) {
      if (total >= c.minExp) level = Math.max(level, c.level);
    }
    return level;
  }

  private nextLevelExp(level: number, configs: { level: number; minExp: bigint }[]): number | null {
    const next = configs.find((c) => c.level === level + 1);
    return next ? Number(next.minExp) : null;
  }

  /** Grant rewards for every level crossed (oldLevel, newLevel]. */
  private async grantCrossedLevels(
    userId: string,
    oldLevel: number,
    newLevel: number,
  ): Promise<LevelRewardSummary[]> {
    const all: LevelRewardSummary[] = [];
    for (const cfg of this.userLevels) {
      if (cfg.level > oldLevel && cfg.level <= newLevel) {
        const rewards = (cfg.rewards as unknown as RewardEntry[]) ?? [];
        if (rewards.length === 0) continue;
        const summaries = await this.granter.grant(userId, rewards, `level:${userId}:${cfg.level}`);
        all.push(...summaries);
      }
    }
    return all;
  }
}
