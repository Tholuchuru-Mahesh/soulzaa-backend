import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { GIFT_EVENTS, GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import {
  TreasureBoxOpenedEvent,
  TreasureProgressEvent,
  TreasureSessionCompletedEvent,
} from '../events/treasure.events';
import { TreasureRepository } from '../repositories/treasure.repository';
import {
  AUDIO_ROOM_EVENTS,
  RoomCreatedEvent,
} from 'src/modules/audio-rooms/events/audio-room.events';
import { TreasureAuditService } from './treasure-audit.service';
import { TreasureDistributionService } from './treasure-distribution.service';
import { TreasureProgressService } from './treasure-progress.service';
import { TreasureRewardService } from './treasure-reward.service';
import { TreasureService } from './treasure.service';

import { WalletCurrency, WalletTxnReason } from '@prisma/client';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';

@Injectable()
export class TreasureEventService implements OnModuleInit {
  private readonly logger = new Logger(TreasureEventService.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(WALLET_SERVICE) private readonly walletService: IWalletService,
    private readonly progressService: TreasureProgressService,
    private readonly rewardService: TreasureRewardService,
    private readonly distributionService: TreasureDistributionService,
    private readonly auditService: TreasureAuditService,
    private readonly repo: TreasureRepository,
    private readonly treasureService: TreasureService,
  ) {}

  onModuleInit() {
    // Auto-initialize Treasure Box when host starts a Live Audio Room
    this.bus.subscribe<RoomCreatedEvent>(AUDIO_ROOM_EVENTS.CREATED, async (event) => {
      try {
        await this.treasureService.autoStartTodaySession(
          event.payload.roomId,
          event.payload.ownerId,
        );
      } catch (err) {
        this.logger.error(
          `Error auto-initializing Treasure Session on RoomCreatedEvent: ${(err as Error).message}`,
        );
      }
    });

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

    // A self-gift fills the box but must not rank for it. Otherwise a host alone
    // in their own room could hand themselves the top-gifter podium unopposed,
    // which is the one competitive mechanic the box exists to run.
    const isSelfGift = payload.receiverId === userId;

    // Apply gift progress with multi-box overflow support
    const result = await this.progressService.applyGiftProgress(
      roomId,
      userId,
      totalCoins,
      giftTxnId,
      contextType,
      !isSelfGift,
    );

    // If Box 5 was completed and excess coins remained, refund immediately to sender's wallet
    if (result.refundAmount > BigInt(0)) {
      try {
        await this.walletService.credit({
          userId,
          currency: WalletCurrency.GOLD,
          amount: Number(result.refundAmount),
          reason: WalletTxnReason.GIFT_REFUND,
          idempotencyKey: `refund:treasure:box5:${result.sessionId}:${giftTxnId || Date.now()}`,
          referenceType: 'TREASURE_BOX_5_REFUND',
          referenceId: result.sessionId,
        });
        this.logger.log(
          `Refunded ${result.refundAmount} excess coins to user ${userId} upon Box 5 completion.`,
        );
      } catch (refundErr) {
        this.logger.error(
          `Failed to process Box 5 refund for user ${userId}: ${(refundErr as Error).message}`,
        );
      }
    }

    // Audit progress update
    await this.auditService.logAudit('TREASURE_PROGRESS_UPDATED', roomId, undefined, {
      appliedAmount: result.appliedAmount.toString(),
      refundAmount: result.refundAmount.toString(),
      completedCount: result.completedBoxes.length,
    });

    // Publish live TreasureProgressEvent for room sockets
    if (result.activeBox) {
      const topGifters = await this.repo.topContributors(result.activeBox.boxId, 3);
      await this.bus.publish(
        new TreasureProgressEvent({
          roomId,
          sessionId: result.sessionId,
          level: result.activeBox.level,
          progress: Number(result.activeBox.progress),
          threshold: Number(result.activeBox.threshold),
          topGifters: topGifters.map((t, idx) => ({
            rank: idx + 1,
            userId: t.userId,
            amount: Number(t.amount),
          })),
        }),
      );
    }

    // Handle any boxes completed by this gift
    for (const completed of result.completedBoxes) {
      await this.auditService.logAudit('TREASURE_BOX_COMPLETED', roomId, completed.boxId, {
        level: completed.level,
        threshold: completed.threshold.toString(),
      });

      // Distribute exclusive Backpack inventory rewards to Top 3 contributors
      const dist = await this.distributionService.distributeBoxRewards(
        result.sessionId,
        completed.boxId,
        roomId,
        completed.level,
      );

      await this.auditService.logAudit('TREASURE_REWARD_DISTRIBUTED', roomId, completed.boxId, {
        winnersCount: dist.winnersCount,
      });

      // Fetch top gifters for opened box event
      const topGifters = await this.repo.topContributors(completed.boxId, 3);

      // Construct room system announcement text
      const medals = ['🥇', '🥈', '🥉'];
      const winnerLines = dist.distributions
        .map(
          (d, idx) =>
            `${medals[idx] || '🎖️'} Rank ${d.rank} won ${d.itemName || 'Exclusive Reward'}`,
        )
        .join('  ');

      const _announcementContent = `🎁 Treasure Box Level ${completed.level} Opened! ${winnerLines}`;

      // Publish TreasureBoxOpenedEvent
      await this.bus.publish(
        new TreasureBoxOpenedEvent({
          roomId,
          sessionId: result.sessionId,
          level: completed.level,
          topGifters: topGifters.map((t, idx) => ({
            rank: idx + 1,
            userId: t.userId,
            amount: Number(t.amount),
          })),
          rewards: dist.distributions.map((d) => ({
            userId: d.userId,
            rank: d.rank,
            kind: 'BACKPACK_ITEM',
            coins: null,
            itemName: d.itemName,
          })),
          nextLevel: completed.level < 5 ? completed.level + 1 : null,
        }),
      );
    }

    if (result.sessionCompleted) {
      await this.bus.publish(
        new TreasureSessionCompletedEvent({
          roomId,
          sessionId: result.sessionId,
        }),
      );
    }
  }
}
