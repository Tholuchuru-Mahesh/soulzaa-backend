import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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

export interface RewardItemPayload {
  type:
    | 'FREE_COINS'
    | 'COINS'
    | 'GAME_COINS'
    | 'GOLD'
    | 'DIAMONDS'
    | 'EXP'
    | 'FRAME'
    | 'THEME'
    | 'BUBBLE'
    | 'ENTRANCE_EFFECT'
    | 'BADGE'
    | 'DECORATION'
    | 'COSMETIC'
    | 'GIFT'
    | 'ITEM';
  amount?: number;
  cosmeticId?: string;
  durationDays?: number;
  expiresAt?: Date | string;
  giftId?: string;
  quantity?: number;
  name?: string;
  metadata?: Record<string, any>;
}

export interface FulfillRewardInput {
  userId: string;
  rewardDefinition: Record<string, any> | RewardItemPayload[];
  referenceType?: 'task' | 'mission' | 'event' | 'achievement' | 'attendance' | 'manual';
  referenceId?: string;
  source?: BackpackItemSource;
}

export interface RewardExecutionResult {
  userId: string;
  coinsAwarded: number;
  gameCoinsAwarded: number;
  goldCoinsAwarded: number;
  expAwarded: number;
  newLevel: number;
  cosmeticsAwarded: Array<{
    cosmeticId: string;
    type?: string;
    durationDays?: number;
    expiresAt?: Date | null;
  }>;
  giftsAwarded?: Array<{ giftId: string; quantity: number }>;
  itemsAwarded: string[];
}

/**
 * Generic, pluggable Reward Fulfillment Engine.
 *
 * Evaluates any composite reward definition and automatically routes entitlements
 * to their respective domain modules (Wallet, EXP, Cosmetics, Backpack, VIP, Gifts).
 * Enforces TTL expirations, busts Redis caches, publishes domain events, and emits
 * real-time socket signals so all client components update immediately.
 */
@Injectable()
export class RewardFulfillmentEngine {
  private readonly logger = new Logger(RewardFulfillmentEngine.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Optional() @Inject(WALLET_SERVICE) private readonly walletService?: IWalletService,
    @Optional() @Inject(EXP_SERVICE) private readonly expService?: IExpService,
    @Optional() @Inject(COSMETICS_SERVICE) private readonly cosmeticsService?: ICosmeticsService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly cache?: CacheService,
    @Optional() private readonly socketManager?: SocketManager,
  ) {}

  /**
   * Universal reward executor.
   */
  async fulfillRewards(input: FulfillRewardInput): Promise<RewardExecutionResult> {
    const { userId, rewardDefinition } = input;
    const refType = input.referenceType ?? 'task';
    const refId = input.referenceId ?? 'general';
    const timestamp = Date.now();
    const source = input.source ?? BackpackItemSource.EVENT;

    const result: RewardExecutionResult = {
      userId,
      coinsAwarded: 0,
      gameCoinsAwarded: 0,
      goldCoinsAwarded: 0,
      expAwarded: 0,
      newLevel: 1,
      cosmeticsAwarded: [],
      itemsAwarded: [],
    };

    if (!userId || !rewardDefinition) return result;

    const normalizedItems = this.normalizeRewardDefinition(rewardDefinition);

    // 1. Dispatch Free Coins & Game Coins (Integrated with Games Module Wallet Balance)
    const totalFreeCoins = normalizedItems
      .filter((i) => i.type === 'FREE_COINS' || i.type === 'COINS')
      .reduce((sum, i) => sum + (Number(i.amount) || 0), 0);

    const totalGameCoins = normalizedItems
      .filter((i) => i.type === 'GAME_COINS')
      .reduce((sum, i) => sum + (Number(i.amount) || 0), 0);

    const totalCoinsCombined = totalFreeCoins + totalGameCoins;

    if (totalCoinsCombined > 0 && this.walletService) {
      try {
        await this.walletService.credit({
          userId,
          currency: WalletCurrency.GAME,
          amount: totalCoinsCombined,
          reason: WalletTxnReason.EVENT_REWARD,
          idempotencyKey: `reward:${refType}:${refId}:${userId}:coins:${timestamp}`,
          referenceType: refType,
          referenceId: refId,
        });
        result.coinsAwarded = totalFreeCoins;
        result.gameCoinsAwarded = totalGameCoins;
        this.logger.log(
          `Credited ${totalFreeCoins} Free Coins and ${totalGameCoins} Game Coins (Total: ${totalCoinsCombined}) to game balance of user ${userId} for ${refType}:${refId}`,
        );

        // Fetch fresh unified wallet balance
        const balances = await this.walletService.getBalance(userId).catch(() => null);
        const gameBalance = balances?.game ?? totalFreeCoins;
        const goldBalance = balances?.gold ?? 0;
        const diamondBalance = balances?.diamond ?? 0;

        await this.publishSilent('wallet.balance_updated', {
          userId,
          gameBalance,
          freeCoins: gameBalance,
        });
        this.emitToUser(userId, 'balanceChanged', {
          userId,
          coins: gameBalance,
          freeCoins: gameBalance,
          game: gameBalance,
          gold: goldBalance,
          diamond: diamondBalance,
        });
        this.emitToUser(userId, 'walletUpdated', {
          userId,
          coins: gameBalance,
          freeCoins: gameBalance,
          game: gameBalance,
          gold: goldBalance,
          diamond: diamondBalance,
        });
      } catch (err) {
        this.logger.error(
          `Failed to credit free coins to user ${userId}: ${(err as Error).message}`,
        );
      }
    }

    // 2. Dispatch Diamonds / Gold Coins
    const totalGoldCoins = normalizedItems
      .filter((i) => i.type === 'GOLD' || i.type === 'DIAMONDS')
      .reduce((sum, i) => sum + (Number(i.amount) || 0), 0);

    if (totalGoldCoins > 0 && this.walletService) {
      try {
        await this.walletService.credit({
          userId,
          currency: WalletCurrency.GOLD,
          amount: totalGoldCoins,
          reason: WalletTxnReason.EVENT_REWARD,
          idempotencyKey: `reward:${refType}:${refId}:${userId}:gold_coins:${timestamp}`,
          referenceType: refType,
          referenceId: refId,
        });
        result.goldCoinsAwarded = totalGoldCoins;
        this.logger.log(
          `Credited ${totalGoldCoins} gold coins to user ${userId} for ${refType}:${refId}`,
        );
        await this.publishSilent('wallet.balance_updated', { userId });
        this.emitToUser(userId, 'balanceChanged', { userId, goldCoins: totalGoldCoins });
        this.emitToUser(userId, 'walletUpdated', { userId, goldCoins: totalGoldCoins });
      } catch (err) {
        this.logger.error(
          `Failed to credit gold coins to user ${userId}: ${(err as Error).message}`,
        );
      }
    }

    // 3. Dispatch EXP Points
    const totalExp = normalizedItems
      .filter((i) => i.type === 'EXP')
      .reduce((sum, i) => sum + (Number(i.amount) || 0), 0);

    if (totalExp > 0) {
      if (this.expService) {
        try {
          const expRes = await this.expService.award({
            userId,
            amount: totalExp,
            source: ExpSource.TASK_COMPLETION,
            idempotencyKey: `reward:${refType}:${refId}:${userId}:exp:${timestamp}`,
            referenceType: refType,
            referenceId: refId,
          });
          result.newLevel = expRes.level;
          result.expAwarded = totalExp;
          this.logger.log(`Awarded ${totalExp} EXP to user ${userId} (level ${result.newLevel})`);
        } catch (err) {
          this.logger.error(`Failed to award EXP to user ${userId}: ${(err as Error).message}`);
        }
      }

      if (this.prisma) {
        try {
          await this.prisma.userStatistics.upsert({
            where: { userId },
            update: {
              exp: { increment: totalExp },
              ...(result.newLevel > 1 ? { level: result.newLevel } : {}),
            },
            create: {
              userId,
              exp: totalExp,
              level: result.newLevel,
            },
          });
        } catch (err) {
          this.logger.error(
            `Failed to sync user statistics for user ${userId}: ${(err as Error).message}`,
          );
        }
      }

      await this.publishSilent('user.profile_updated', { userId });
      this.emitToUser(userId, 'user.stats_updated', {
        userId,
        exp: totalExp,
        level: result.newLevel,
      });
    }

    // 4. Dispatch Cosmetics (Frames, Themes, Entrance Effects, Badges, Bubbles, Decorations)
    const cosmeticItems = normalizedItems.filter((i) =>
      ['FRAME', 'THEME', 'BUBBLE', 'ENTRANCE_EFFECT', 'BADGE', 'DECORATION', 'COSMETIC'].includes(
        i.type,
      ),
    );

    if (cosmeticItems.length > 0 && this.cosmeticsService) {
      for (const item of cosmeticItems) {
        const cosmeticRef = item.cosmeticId || item.name;
        if (!cosmeticRef) continue;

        try {
          const grantRes = await this.cosmeticsService.grantToUser({
            userId,
            cosmeticId: cosmeticRef,
            source,
            grantKey: `reward:${refType}:${refId}:${userId}:cosmetic:${cosmeticRef}:${timestamp}`,
            durationDays: item.durationDays,
            expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
          });

          if (grantRes) {
            const computedExpiresAt = item.expiresAt
              ? new Date(item.expiresAt)
              : item.durationDays && item.durationDays > 0
                ? new Date(Date.now() + item.durationDays * 86400000)
                : null;

            result.cosmeticsAwarded.push({
              cosmeticId: grantRes.cosmeticId,
              type: item.type,
              durationDays: item.durationDays,
              expiresAt: computedExpiresAt,
            });
            this.logger.log(
              `Granted cosmetic [${item.type}] ${grantRes.cosmeticId} (${item.durationDays ? `${item.durationDays}d TTL` : 'Permanent'}) to user ${userId}`,
            );
          }
        } catch (err) {
          this.logger.error(
            `Failed to grant cosmetic ${cosmeticRef} to user ${userId}: ${(err as Error).message}`,
          );
        }
      }
      await this.publishSilent('backpack.item_granted', { userId });
      await this.publishSilent('user.profile_updated', { userId });
    }

    // 5. Dispatch Virtual Gifts
    const giftItems = normalizedItems.filter((i) => i.type === 'GIFT');
    if (giftItems.length > 0) {
      result.giftsAwarded = giftItems.map((g) => ({
        giftId: g.giftId || g.name || 'gift',
        quantity: g.quantity || g.amount || 1,
      }));
      this.logger.log(`Awarded ${giftItems.length} gift reward packages to user ${userId}`);
    }

    // Invalidate profile cache in Redis
    await this.invalidateProfileCache(userId);

    // Push consolidated real-time reward completion socket event
    this.emitToUser(userId, 'task:reward_claimed', {
      userId,
      referenceType: refType,
      referenceId: refId,
      taskId: refType === 'task' ? refId : undefined,
      missionId: refType === 'mission' ? refId : undefined,
      coinsAwarded: result.coinsAwarded,
      goldCoinsAwarded: result.goldCoinsAwarded,
      expAwarded: result.expAwarded,
      cosmeticsAwarded: result.cosmeticsAwarded,
      giftsAwarded: result.giftsAwarded,
      newLevel: result.newLevel,
    });

    return result;
  }

  /**
   * Normalizes any input format (structured `items` array or flat object keys)
   * into a clean list of `RewardItemPayload` objects.
   */
  private normalizeRewardDefinition(
    def: Record<string, any> | RewardItemPayload[],
  ): RewardItemPayload[] {
    const items: RewardItemPayload[] = [];

    if (Array.isArray(def)) {
      for (const item of def) {
        if (item && typeof item === 'object' && item.type) {
          items.push({
            type: String(item.type).toUpperCase() as any,
            amount: Number(item.amount) || undefined,
            cosmeticId: item.cosmeticId || item.id || item.refId,
            durationDays: Number(item.durationDays) || undefined,
            expiresAt: item.expiresAt,
            giftId: item.giftId,
            quantity: Number(item.quantity) || undefined,
            name: item.name,
            metadata: item.metadata,
          });
        }
      }
      return items;
    }

    if (typeof def !== 'object' || def === null) return items;

    // Check if the object has an `items` array
    if (Array.isArray(def.items) && def.items.length > 0) {
      return this.normalizeRewardDefinition(def.items);
    }

    // Free Coins (Platform Engagement / Attendance)
    const freeCoins = Number(def.freeCoins ?? (!def.gameCoins ? def.coins : 0) ?? 0);
    if (freeCoins > 0) {
      items.push({ type: 'FREE_COINS', amount: freeCoins });
    }

    // Game Coins (Mini-games & Casino Games)
    const gameCoins = Number(def.gameCoins ?? 0);
    if (gameCoins > 0) {
      items.push({ type: 'GAME_COINS', amount: gameCoins });
    }

    // Diamonds / Gold Coins
    const goldCoins = Number(def.goldCoins ?? def.diamonds ?? def.gold ?? 0);
    if (goldCoins > 0) {
      items.push({ type: 'GOLD', amount: goldCoins });
    }

    // EXP
    const exp = Number(def.exp ?? def.expAmount ?? 0);
    if (exp > 0) {
      items.push({ type: 'EXP', amount: exp });
    }

    // Frames
    const frameId = def.frameId || (def.cosmeticId?.includes('frame') ? def.cosmeticId : null);
    if (frameId) {
      items.push({
        type: 'FRAME',
        cosmeticId: String(frameId).trim(),
        durationDays: this.parseDurationDays(
          def.frameDurationDays ?? def.frameDuration ?? def.durationDays,
          def.frameDurationUnit ?? def.durationUnit,
        ),
      });
    }

    // Themes
    const themeId = def.themeId || (def.cosmeticId?.includes('theme') ? def.cosmeticId : null);
    if (themeId) {
      items.push({
        type: 'THEME',
        cosmeticId: String(themeId).trim(),
        durationDays: this.parseDurationDays(
          def.themeDurationDays ?? def.themeDuration ?? def.durationDays,
          def.themeDurationUnit ?? def.durationUnit,
        ),
      });
    }

    // Bubbles
    const bubbleId = def.bubbleId || (def.cosmeticId?.includes('bubble') ? def.cosmeticId : null);
    if (bubbleId) {
      items.push({
        type: 'BUBBLE',
        cosmeticId: String(bubbleId).trim(),
        durationDays: this.parseDurationDays(
          def.bubbleDurationDays ?? def.bubbleDuration ?? def.durationDays,
          def.bubbleDurationUnit ?? def.durationUnit,
        ),
      });
    }

    // Entrance Rides
    const entranceId =
      def.entranceEffectId || (def.cosmeticId?.includes('ride') ? def.cosmeticId : null);
    if (entranceId) {
      items.push({
        type: 'ENTRANCE_EFFECT',
        cosmeticId: String(entranceId).trim(),
        durationDays: this.parseDurationDays(
          def.entranceDurationDays ?? def.entranceDuration ?? def.durationDays,
          def.entranceDurationUnit ?? def.durationUnit,
        ),
      });
    }

    // Badges
    const badgeId = def.badgeId || (def.cosmeticId?.includes('badge') ? def.cosmeticId : null);
    if (badgeId) {
      items.push({
        type: 'BADGE',
        cosmeticId: String(badgeId).trim(),
      });
    }

    // Generic Cosmetic Fallback
    if (def.cosmeticId && !items.some((i) => i.cosmeticId === def.cosmeticId)) {
      items.push({
        type: 'COSMETIC',
        cosmeticId: String(def.cosmeticId).trim(),
        durationDays: this.parseDurationDays(def.durationDays, def.durationUnit),
      });
    }

    // Multi-Cosmetic IDs list
    if (Array.isArray(def.cosmeticIds)) {
      for (const id of def.cosmeticIds) {
        if (typeof id === 'string' && id.trim() && !items.some((i) => i.cosmeticId === id)) {
          items.push({ type: 'COSMETIC', cosmeticId: id.trim() });
        }
      }
    }

    // Virtual Gifts
    if (def.giftId) {
      items.push({
        type: 'GIFT',
        giftId: String(def.giftId),
        quantity: Number(def.giftQuantity ?? def.quantity) || 1,
      });
    }

    return items;
  }

  private async invalidateProfileCache(userId: string): Promise<void> {
    if (this.cache) {
      try {
        await this.cache.del(`${CACHE_KEYS.USER}profile:${userId}`);
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

  private parseDurationDays(amount?: number | string, unit?: string): number | undefined {
    if (amount === undefined || amount === null || amount === '') return undefined;
    const num = Number(amount);
    if (isNaN(num) || num <= 0) return undefined;
    const u = String(unit || 'DAYS').toUpperCase();
    if (u === 'MINUTES' || u === 'MINS' || u === 'MINUTE' || u === 'MIN') {
      return Math.round((num / 1440) * 1000000) / 1000000;
    }
    if (u === 'HOURS' || u === 'HOUR' || u === 'HRS' || u === 'HR') {
      return Math.round((num / 24) * 1000000) / 1000000;
    }
    return num;
  }

  private emitToUser(userId: string, event: string, payload: Record<string, unknown>): void {
    if (this.socketManager) {
      try {
        this.socketManager.emitToUserEverywhere(userId, event, payload);
      } catch {
        // non-fatal
      }
    }
  }
}
