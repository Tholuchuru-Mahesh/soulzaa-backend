import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { GiftContextType, type Gift, type GiftTransaction } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { GiftCatalogService } from 'src/modules/gifts/services/gift-catalog.service';
import { GiftService } from 'src/modules/gifts/services/gift.service';
import type { RoomActor } from '../interfaces/room-actor.interface';
import {
  GIFT_CATEGORY_ATTEMPTS,
  GIFT_CATEGORY_PRIORITY,
  GIFT_DELIVERY_BACKOFF_MS,
  VIDEO_ROOM_GIFT_EVENT_TYPES,
  VIDEO_ROOM_GIFT_QUEUE_JOB,
} from '../constants/video-room-gift.constants';
import type { SendVideoRoomGiftDto } from '../dto/send-video-room-gift.dto';
import { VideoRoomGiftQueueUpdatedEvent } from '../events/video-room-gift.events';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import { VideoRoomGiftComboService } from './video-room-gift-combo.service';
import { VideoRoomGiftStatisticsService } from './video-room-gift-statistics.service';
import { VideoRoomGiftTargetResolver } from './video-room-gift-target.resolver';

/** Payload of the queued delivery job. */
export interface VideoRoomGiftDeliveryJob {
  batchId: string;
  roomId: string;
  senderId: string;
  giftId: string;
  giftName: string;
  animationUrl: string | null;
  soundUrl: string | null;
  comboTier: number;
  quantity: number;
  totalCoinValue: number;
  transactionIds: string[];
  receiverIds: string[];
}

/** What `POST /gifts/send` returns. */
export interface VideoRoomGiftBatchView {
  batchId: string;
  roomId: string;
  giftId: string;
  comboTier: number;
  totalCoinValue: number;
  transactions: {
    transactionId: string;
    receiverId: string;
    coinValue: number;
    receiverEarnings: number;
  }[];
}

/**
 * Video-room gift orchestration (VR-10).
 *
 * Owns the ORDER of operations, not the money: recipients are resolved, the
 * shared pipeline performs the ACID send, and only once that has committed does
 * anything non-transactional happen — combo tick, statistics, audit rows and the
 * delivery job.
 *
 * That ordering is the whole design. Redis writes cannot roll back, and a queued
 * job can be picked up by another process before the transaction commits, so a
 * side effect that ran early could announce a gift that never happened.
 */
@Injectable()
export class VideoRoomGiftService {
  private readonly logger = new Logger(VideoRoomGiftService.name);

  constructor(
    private readonly resolver: VideoRoomGiftTargetResolver,
    private readonly gifts: GiftService,
    private readonly catalog: GiftCatalogService,
    private readonly combo: VideoRoomGiftComboService,
    private readonly statistics: VideoRoomGiftStatisticsService,
    private readonly events: VideoRoomEventsRepository,
    private readonly queue: QueueService,
    private readonly metrics: VideoRoomsMetrics,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async send(
    actor: RoomActor,
    roomId: string,
    dto: SendVideoRoomGiftDto,
  ): Promise<VideoRoomGiftBatchView> {
    const startedAt = Date.now();
    const gift = await this.catalog.getGift(dto.giftId);
    if (!gift) {
      throw new BusinessException(
        ERROR_CODES.GIFT_NOT_FOUND,
        'Gift not found.',
        HttpStatus.NOT_FOUND,
      );
    }

    const receiverIds = await this.resolver.resolve(roomId, dto, actor.id);

    // ---- ACID boundary: everything that moves coins happens here. ----
    const walletStartedAt = Date.now();
    const transactions = await this.gifts.sendGiftBatch(actor, {
      giftId: dto.giftId,
      receiverIds,
      contextType: GiftContextType.VIDEO_ROOM,
      contextId: roomId,
      quantity: dto.quantity,
      idempotencyKey: dto.idempotencyKey,
    } as never);
    this.metrics.observeGiftWalletLatency((Date.now() - walletStartedAt) / 1000);

    // Revenue + volume, one call per ledger row: an N-receiver send is N gifts.
    for (const txn of transactions) {
      this.metrics.incGiftSent(gift.category, Number(txn.totalCoinValue));
    }

    // ---- Post-commit only. Failures here are logged, never thrown: the gift
    //      is already paid for, and refusing the response would be a lie. ----
    const batchId = this.batchIdOf(transactions);
    const comboTier = await this.tickCombo(roomId, actor.id, gift, transactions);
    await this.recordSideEffects(roomId, actor.id, gift, transactions, batchId, comboTier);

    // Measured end-to-end but EXCLUDING animation delivery, which is async by
    // design — folding it in would make the number describe the queue, not the
    // request the user is waiting on.
    this.metrics.observeGiftSendLatency((Date.now() - startedAt) / 1000);

    return this.toView(roomId, gift, transactions, batchId, comboTier);
  }

  /** Combo advances once per SEND, never once per receiver. */
  private async tickCombo(
    roomId: string,
    senderId: string,
    gift: Gift,
    transactions: GiftTransaction[],
  ): Promise<number> {
    if (!gift.comboEnabled) return transactions[0]?.comboTier ?? 1;
    try {
      const total = transactions.reduce((sum, t) => sum + Number(t.totalCoinValue), 0);
      const { tier } = await this.combo.tick(roomId, senderId, gift, total);
      return tier;
    } catch (err) {
      this.logger.warn(`combo tick failed for room ${roomId}: ${(err as Error).message}`);
      return transactions[0]?.comboTier ?? 1;
    }
  }

  private async recordSideEffects(
    roomId: string,
    senderId: string,
    gift: Gift,
    transactions: GiftTransaction[],
    batchId: string,
    comboTier: number,
  ): Promise<void> {
    try {
      await this.statistics.record(roomId, transactions);
    } catch (err) {
      this.logger.warn(`gift statistics failed for room ${roomId}: ${(err as Error).message}`);
    }

    const job: VideoRoomGiftDeliveryJob = {
      batchId,
      roomId,
      senderId,
      giftId: gift.id,
      giftName: gift.name,
      animationUrl: gift.animationUrl,
      soundUrl: gift.soundUrl,
      comboTier,
      quantity: transactions[0]?.quantity ?? 1,
      totalCoinValue: transactions.reduce((sum, t) => sum + Number(t.totalCoinValue), 0),
      transactionIds: transactions.map((t) => t.id),
      receiverIds: transactions.map((t) => t.receiverId),
    };

    try {
      await this.events.appendEvent({
        roomId,
        actorId: senderId,
        eventType: VIDEO_ROOM_GIFT_EVENT_TYPES.ANIMATION_QUEUED,
        payload: { ...job },
        referenceId: transactions[0]?.id,
        correlationId: batchId,
      });
    } catch (err) {
      this.logger.warn(`gift audit append failed for room ${roomId}: ${(err as Error).message}`);
    }

    try {
      // One job per BATCH: a "gift the stage" send plays one animation, not N.
      await this.queue.enqueue(QUEUE_NAMES.GIFT_PROCESSING, VIDEO_ROOM_GIFT_QUEUE_JOB, job, {
        priority: GIFT_CATEGORY_PRIORITY[gift.category],
        attempts: GIFT_CATEGORY_ATTEMPTS[gift.category],
        backoff: { type: 'exponential', delay: GIFT_DELIVERY_BACKOFF_MS },
        removeOnComplete: true,
      });
      await this.publishQueueDepth(roomId, batchId, gift.category);
    } catch (err) {
      // A queue outage delays animations; it must never fail a paid gift.
      this.logger.error(
        `failed to enqueue gift delivery for batch ${batchId}: ${(err as Error).message}`,
      );
      this.metrics.incGiftFailure();
    }
  }

  /**
   * Publish the live delivery-queue depth: a `giftQueueUpdated` socket event so
   * clients can show a backlog indicator during a gift storm, plus the Prometheus
   * gauge. Best-effort — a depth read that fails must not disturb a paid gift.
   */
  private async publishQueueDepth(
    roomId: string,
    batchId: string,
    category: string,
  ): Promise<void> {
    try {
      const counts = await this.queue.getJobCounts(QUEUE_NAMES.GIFT_PROCESSING);
      const pending = Number(counts?.waiting ?? 0) + Number(counts?.delayed ?? 0);
      const active = Number(counts?.active ?? 0);

      this.metrics.setGiftQueueDepth(pending);
      this.metrics.setGiftAnimationQueueDepth(pending + active);

      await this.bus.publish(
        new VideoRoomGiftQueueUpdatedEvent({
          roomId,
          batchId,
          category,
          pending,
          active,
        }),
      );
    } catch (err) {
      this.logger.debug(`queue depth unavailable for batch ${batchId}: ${(err as Error).message}`);
    }
  }

  private batchIdOf(transactions: GiftTransaction[]): string {
    const metadata = transactions[0]?.metadata as { batchId?: string } | null;
    return metadata?.batchId ?? transactions[0]?.id ?? '';
  }

  private toView(
    roomId: string,
    gift: Gift,
    transactions: GiftTransaction[],
    batchId: string,
    comboTier: number,
  ): VideoRoomGiftBatchView {
    return {
      batchId,
      roomId,
      giftId: gift.id,
      comboTier,
      totalCoinValue: transactions.reduce((sum, t) => sum + Number(t.totalCoinValue), 0),
      transactions: transactions.map((t) => ({
        transactionId: t.id,
        receiverId: t.receiverId,
        coinValue: Number(t.totalCoinValue),
        receiverEarnings: Number(t.creatorEarnings),
      })),
    };
  }
}
