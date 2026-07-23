import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { GIFT_EVENTS, GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { TreasureAuditService } from './treasure-audit.service';
import { TreasureDistributionService } from './treasure-distribution.service';
import { TreasureProgressService } from './treasure-progress.service';
import { TreasureRewardService } from './treasure-reward.service';

@Injectable()
export class TreasureEventService implements OnModuleInit {
  private readonly logger = new Logger(TreasureEventService.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly progressService: TreasureProgressService,
    private readonly rewardService: TreasureRewardService,
    private readonly distributionService: TreasureDistributionService,
    private readonly auditService: TreasureAuditService,
  ) {}

  onModuleInit() {
    // Event-driven subscription to GiftSentEvent
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, async (event) => {
      try {
        await this.handleGiftSent(event.payload);
      } catch (err) {
        this.logger.error(
          `Error handling GiftSentEvent in Treasure Engine: ${(err as Error).message}`,
        );
      }
    });
  }

  /**
   * Processes a GiftSentEvent payload to update treasure progress and trigger box completions.
   */
  async handleGiftSent(payload: any) {
    const roomId = payload.contextId;
    const userId = payload.senderId;
    const totalCoins = BigInt(payload.totalCoinValue);
    const giftTxnId = payload.transactionId;
    const contextType = payload.contextType || 'AUDIO_ROOM';

    if (!roomId || totalCoins <= BigInt(0)) return;

    // Apply gift progress with multi-box overflow support
    const result = await this.progressService.applyGiftProgress(
      roomId,
      userId,
      totalCoins,
      giftTxnId,
      contextType,
    );

    // Audit progress update
    await this.auditService.logAudit('TREASURE_PROGRESS_UPDATED', roomId, undefined, {
      appliedAmount: totalCoins.toString(),
      completedCount: result.completedBoxes.length,
    });

    // Handle any boxes completed by this gift
    for (const completed of result.completedBoxes) {
      await this.auditService.logAudit('TREASURE_BOX_COMPLETED', roomId, completed.boxId, {
        level: completed.level,
        threshold: completed.threshold.toString(),
      });

      // Calculate reward pool dynamically from config
      const pool = await this.rewardService.calculateRewardPool(
        completed.level,
        completed.threshold,
      );

      await this.auditService.logAudit('TREASURE_REWARD_GENERATED', roomId, completed.boxId, {
        totalRewardPool: pool.totalRewardPool.toString(),
        percentage: pool.rewardPoolPercentage,
      });

      // Distribute rewards to 5-7 eligible winners
      const dist = await this.distributionService.distributeBoxRewards(
        result.sessionId,
        completed.boxId,
        roomId,
        completed.level,
        pool.totalRewardPool,
      );

      await this.auditService.logAudit('TREASURE_REWARD_DISTRIBUTED', roomId, completed.boxId, {
        winnersCount: dist.winnersCount,
      });

      // Publish TreasureBoxOpenedEvent
      await this.bus.publish({
        name: 'treasure.box_opened',
        payload: {
          sessionId: result.sessionId,
          roomId,
          boxId: completed.boxId,
          level: completed.level,
          totalRewardPool: pool.totalRewardPool.toString(),
          winners: dist.distributions,
        },
      } as any);
    }
  }
}
