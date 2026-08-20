import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { BackpackItemSource, WalletCurrency, WalletTxnReason } from '@prisma/client';
import { CACHE_KEYS } from 'src/common/constants';
import { ExpSource } from 'src/common/enums/exp-source.enum';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import { EXP_SERVICE, type IExpService } from 'src/modules/exp/interfaces/exp.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';

export interface RewardDispatchedPayload {
  userId: string;
  taskId?: string;
  missionId?: string;
  rewardDefinition: Record<string, any>;
}

/**
 * Listens for `reward.dispatched` domain events from the Tasks & Missions Engine
 * and executes dynamic concrete credits (Free/Game Coins, Gold Coins, EXP, Frames,
 * Themes, Chat Bubbles, Entrance Effects, Badges, Custom Items) via their respective
 * domain services, syncing user statistics and invalidating profile cache, then
 * pushes real-time socket events so the mobile app updates without a reload.
 */
@Injectable()
export class TaskRewardExecutionListener implements OnModuleInit {
  private readonly logger = new Logger(TaskRewardExecutionListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Optional() @Inject(WALLET_SERVICE) private readonly walletService?: IWalletService,
    @Optional() @Inject(EXP_SERVICE) private readonly expService?: IExpService,
    @Optional() @Inject(COSMETICS_SERVICE) private readonly cosmeticsService?: ICosmeticsService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly cache?: CacheService,
    @Optional() private readonly socketManager?: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe('reward.dispatched', async (event) => {
      await this.handleRewardDispatched(event.payload as RewardDispatchedPayload);
    });
  }

  /** Profile cache key — mirrors ProfileService.cacheKey(). */
  private profileCacheKey(userId: string): string {
    return `${CACHE_KEYS.USER}profile:${userId}`;
  }

  private async invalidateProfileCache(userId: string): Promise<void> {
    if (this.cache) {
      try {
        await this.cache.del(this.profileCacheKey(userId));
      } catch {
        // non-fatal
      }
    }
  }

  private async publishSilent(name: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.bus.publish({ name, payload, timestamp: new Date() } as any);
    } catch {
      // non-fatal
    }
  }

  /** Push a real-time socket event to all of a user's connected devices. */
  private emitToUser(userId: string, event: string, payload: Record<string, unknown>): void {
    if (this.socketManager) {
      try {
        this.socketManager.emitToUserEverywhere(userId, event, payload);
      } catch {
        // non-fatal — socket is optional
      }
    }
  }

  private async handleRewardDispatched(payload: RewardDispatchedPayload): Promise<void> {
    if (!payload?.userId || !payload?.rewardDefinition) return;

    const { userId, taskId, missionId, rewardDefinition } = payload;
    const refId = taskId ?? missionId ?? 'general';
    const timestamp = Date.now();

    let freeCoinsAwarded = 0;
    let goldCoinsAwarded = 0;
    let expAwarded = 0;
    const cosmeticsAwarded: string[] = [];
    let newLevel = 1;

    // 1. Credit Free / Game Coins
    const freeCoins = Number(
      rewardDefinition.freeCoins ?? rewardDefinition.coins ?? rewardDefinition.gameCoins ?? 0,
    );
    if (freeCoins > 0 && this.walletService) {
      try {
        await this.walletService.credit({
          userId,
          currency: WalletCurrency.GAME,
          amount: freeCoins,
          reason: WalletTxnReason.EVENT_REWARD,
          idempotencyKey: `task-reward:${refId}:${userId}:free_coins:${timestamp}`,
          referenceType: taskId ? 'task' : 'mission',
          referenceId: refId,
        });
        freeCoinsAwarded = freeCoins;
        this.logger.log(`Credited ${freeCoins} free coins to user ${userId} for ${refId}`);
        await this.invalidateProfileCache(userId);
        await this.publishSilent('wallet.balance_updated', { userId });
        this.emitToUser(userId, 'balanceChanged', { userId, coins: freeCoins });
        this.emitToUser(userId, 'walletUpdated', { userId, coins: freeCoins });
      } catch (err) {
        this.logger.error(
          `Failed to credit free coins for task reward to user ${userId}: ${(err as Error).message}`,
        );
      }
    }

    // 2. Credit Gold / Diamond Coins
    const goldCoins = Number(
      rewardDefinition.goldCoins ?? rewardDefinition.diamonds ?? rewardDefinition.gold ?? 0,
    );
    if (goldCoins > 0 && this.walletService) {
      try {
        await this.walletService.credit({
          userId,
          currency: WalletCurrency.GOLD,
          amount: goldCoins,
          reason: WalletTxnReason.EVENT_REWARD,
          idempotencyKey: `task-reward:${refId}:${userId}:gold_coins:${timestamp}`,
          referenceType: taskId ? 'task' : 'mission',
          referenceId: refId,
        });
        goldCoinsAwarded = goldCoins;
        this.logger.log(`Credited ${goldCoins} gold coins to user ${userId} for ${refId}`);
        await this.invalidateProfileCache(userId);
        await this.publishSilent('wallet.balance_updated', { userId });
        this.emitToUser(userId, 'balanceChanged', { userId, goldCoins });
        this.emitToUser(userId, 'walletUpdated', { userId, goldCoins });
      } catch (err) {
        this.logger.error(
          `Failed to credit gold coins for task reward to user ${userId}: ${(err as Error).message}`,
        );
      }
    }

    // 3. Award EXP
    const exp = Number(rewardDefinition.exp ?? rewardDefinition.expAmount ?? 0);
    if (exp > 0) {
      if (this.expService) {
        try {
          const res = await this.expService.award({
            userId,
            amount: exp,
            source: ExpSource.TASK_COMPLETION,
            idempotencyKey: `task-reward:${refId}:${userId}:exp:${timestamp}`,
            referenceType: taskId ? 'task' : 'mission',
            referenceId: refId,
          });
          newLevel = res.level;
          expAwarded = exp;
          this.logger.log(`Awarded ${exp} EXP to user ${userId} for ${refId} (level ${newLevel})`);
        } catch (err) {
          this.logger.error(
            `Failed to award EXP for task reward to user ${userId}: ${(err as Error).message}`,
          );
        }
      }

      // Sync user_statistics so GET /users/me shows the updated EXP & level immediately.
      if (this.prisma) {
        try {
          await this.prisma.userStatistics.upsert({
            where: { userId },
            update: {
              exp: { increment: exp },
              ...(newLevel > 1 ? { level: newLevel } : {}),
            },
            create: {
              userId,
              exp,
              level: newLevel,
            },
          });
        } catch (err) {
          this.logger.error(
            `Failed to sync user_statistics for user ${userId}: ${(err as Error).message}`,
          );
        }
      }

      await this.invalidateProfileCache(userId);
      await this.publishSilent('user.profile_updated', { userId });
      this.emitToUser(userId, 'user.stats_updated', { userId, exp, level: newLevel });
    }

    // 4. Grant Dynamic Cosmetics (Frames, Themes, Bubbles, Entrance Effects, Badges, Custom Items)
    const targetCosmeticIds: string[] = [];

    if (typeof rewardDefinition.cosmeticId === 'string' && rewardDefinition.cosmeticId.trim()) {
      targetCosmeticIds.push(rewardDefinition.cosmeticId.trim());
    }
    if (typeof rewardDefinition.frameId === 'string' && rewardDefinition.frameId.trim()) {
      targetCosmeticIds.push(rewardDefinition.frameId.trim());
    }
    if (typeof rewardDefinition.themeId === 'string' && rewardDefinition.themeId.trim()) {
      targetCosmeticIds.push(rewardDefinition.themeId.trim());
    }
    if (typeof rewardDefinition.bubbleId === 'string' && rewardDefinition.bubbleId.trim()) {
      targetCosmeticIds.push(rewardDefinition.bubbleId.trim());
    }
    if (typeof rewardDefinition.badgeId === 'string' && rewardDefinition.badgeId.trim()) {
      targetCosmeticIds.push(rewardDefinition.badgeId.trim());
    }
    if (typeof rewardDefinition.entranceEffectId === 'string' && rewardDefinition.entranceEffectId.trim()) {
      targetCosmeticIds.push(rewardDefinition.entranceEffectId.trim());
    }
    if (Array.isArray(rewardDefinition.cosmeticIds)) {
      for (const id of rewardDefinition.cosmeticIds) {
        if (typeof id === 'string' && id.trim()) targetCosmeticIds.push(id.trim());
      }
    }
    if (Array.isArray(rewardDefinition.items)) {
      for (const item of rewardDefinition.items) {
        const id = item?.cosmeticId || item?.id || item?.itemId;
        if (typeof id === 'string' && id.trim()) targetCosmeticIds.push(id.trim());
      }
    }

    const uniqueCosmetics = Array.from(new Set(targetCosmeticIds));
    if (uniqueCosmetics.length > 0 && this.cosmeticsService) {
      for (const cosmeticId of uniqueCosmetics) {
        try {
          await this.cosmeticsService.grantToUser({
            userId,
            cosmeticId,
            source: BackpackItemSource.EVENT,
            grantKey: `task-reward:${refId}:${userId}:cosmetic:${cosmeticId}`,
          });
          cosmeticsAwarded.push(cosmeticId);
          this.logger.log(`Granted cosmetic item ${cosmeticId} to user ${userId} for ${refId}`);
        } catch (err) {
          this.logger.error(
            `Failed to grant cosmetic ${cosmeticId} for task reward to user ${userId}: ${(err as Error).message}`,
          );
        }
      }
      await this.invalidateProfileCache(userId);
      await this.publishSilent('user.profile_updated', { userId });
    }

    // 5. Push a single consolidated real-time event with full reward snapshot
    this.emitToUser(userId, 'task:reward_claimed', {
      userId,
      taskId,
      missionId,
      coinsAwarded: freeCoinsAwarded,
      goldCoinsAwarded,
      expAwarded,
      cosmeticsAwarded,
      newLevel,
    });
  }
}
