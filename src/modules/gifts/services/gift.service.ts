import { randomInt, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Gift,
  GiftContextType,
  GiftTransaction,
  GiftType,
  Prisma,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
} from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { VIP_SERVICE, type IVipService } from 'src/modules/vip/interfaces/vip.service.interface';
import { GIFT_WALLET_REFERENCE_TYPE } from '../constants/gifts.constants';
import type { GiftHistoryDto, SendGiftDto } from '../dto/gift.dto';
import { GiftComboEvent, GiftLuckyWinEvent, GiftSentEvent } from '../events/gift.events';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { GiftRepository } from '../repositories/gift.repository';
import { GiftCatalogService } from './gift-catalog.service';
import { GiftLeaderboardService } from './gift-leaderboard.service';

/** Resolved gift tuning from config. */
interface GiftConfig {
  creatorEarningRatePercent: number;
  senderExpPerCoin: number;
  receiverExpPerCoin: number;
  rateMax: number;
  rateWindowSeconds: number;
}

/**
 * The gift-send pipeline (AR-5). Validates the sender/receiver/context and gift,
 * enforces rate limiting and idempotency, resolves combo tier and lucky
 * multiplier, moves coins through the wallet (debit sender GOLD → credit receiver
 * EARNINGS) with compensating rollback on failure, writes the immutable gift
 * ledger row, updates the live leaderboards, and publishes domain events (bridged
 * to the room socket) plus analytics/notification/ranking jobs. The EXP rewards
 * ride on the published event as the cross-module seam.
 */
@Injectable()
export class GiftService {
  private readonly logger = new Logger(GiftService.name);

  constructor(
    private readonly repo: GiftRepository,
    private readonly catalog: GiftCatalogService,
    private readonly leaderboards: GiftLeaderboardService,
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(AUDIO_ROOMS_SERVICE) private readonly rooms: IAudioRoomsService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    @Inject(VIP_SERVICE) private readonly vip: IVipService,
  ) {}

  async sendGift(actor: RoomActor, dto: SendGiftDto): Promise<GiftTransaction> {
    const cfg = this.giftConfig();
    const senderId = actor.id;

    if (senderId === dto.receiverId) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_GIFT_SELF,
        'You cannot send a gift to yourself.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const gift = await this.catalog.getGift(dto.giftId);
    if (!gift) {
      throw new BusinessException(
        ERROR_CODES.GIFT_NOT_FOUND,
        'Gift not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!gift.enabled) {
      throw new BusinessException(
        ERROR_CODES.GIFT_DISABLED,
        'This gift is not available.',
        HttpStatus.CONFLICT,
      );
    }

    // VIP-exclusive gate: the sender's VIP tier must meet the gift's minimum.
    if (gift.minVipLevel > 0 && (await this.vip.getLevelOrdinal(senderId)) < gift.minVipLevel) {
      throw new BusinessException(
        ERROR_CODES.GIFT_VIP_RESTRICTED,
        'This gift requires a higher VIP level.',
        HttpStatus.FORBIDDEN,
      );
    }

    const idempotencyKey = dto.idempotencyKey?.trim() || `gift:${randomUUID()}`;

    // Idempotent replay: a prior send with this key returns the original row.
    const prior = await this.repo.findTxnByIdempotencyKey(idempotencyKey);
    if (prior) return prior;

    await this.assertContext(dto.contextType, dto.contextId, senderId, dto.receiverId);

    if (await this.repo.hitRateLimit(senderId, cfg.rateMax, cfg.rateWindowSeconds)) {
      throw new BusinessException(
        ERROR_CODES.GIFT_RATE_LIMITED,
        'You are sending gifts too quickly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Combo tier + lucky roll.
    const comboTier = gift.comboEnabled
      ? await this.repo.comboTick(dto.contextId, senderId, dto.giftId, gift.comboWindowSeconds)
      : 1;
    const lucky = this.rollLucky(gift);

    // Economics.
    const unit = gift.coinValue;
    const total = BigInt(unit) * BigInt(dto.quantity) * BigInt(lucky.multiplier);
    const creatorEarnings = (total * BigInt(Math.round(cfg.creatorEarningRatePercent))) / 100n;
    const totalNum = Number(total);
    const earningsNum = Number(creatorEarnings);
    const senderExp = Math.floor(totalNum * cfg.senderExpPerCoin);
    const receiverExp = Math.floor(totalNum * cfg.receiverExpPerCoin);

    // 1) Debit the sender (throws INSUFFICIENT_BALANCE). Idempotent on the key.
    const debit = await this.wallet.debit({
      userId: senderId,
      currency: WalletCurrency.GOLD,
      amount: totalNum,
      reason: WalletTxnReason.GIFT_SEND,
      idempotencyKey: `gift-debit:${idempotencyKey}`,
      referenceType: GIFT_WALLET_REFERENCE_TYPE,
      metadata: { giftId: gift.id, quantity: dto.quantity, contextId: dto.contextId },
      actorId: senderId,
    });

    // 2) Credit the receiver's earnings + 3) persist the ledger row. On any
    //    failure, compensate the debit (and the credit if it landed) so no coins
    //    are lost — the send is all-or-nothing.
    let creditTxnId: string | null = null;
    try {
      const credit = await this.wallet.credit({
        userId: dto.receiverId,
        currency: WalletCurrency.EARNINGS,
        amount: earningsNum > 0 ? earningsNum : 1,
        reason: WalletTxnReason.GIFT_RECEIVE,
        idempotencyKey: `gift-credit:${idempotencyKey}`,
        referenceType: GIFT_WALLET_REFERENCE_TYPE,
        metadata: { giftId: gift.id, senderId },
        actorId: senderId,
      });
      creditTxnId = credit.transactionId;

      const txn = await this.repo.createTransaction({
        senderId,
        receiverId: dto.receiverId,
        giftId: gift.id,
        giftType: gift.type,
        contextType: dto.contextType,
        contextId: dto.contextId,
        quantity: dto.quantity,
        comboTier,
        unitCoinValue: unit,
        totalCoinValue: total,
        creatorEarnings,
        luckyMultiplier: lucky.multiplier,
        isLuckyWin: lucky.win,
        senderExp,
        receiverExp,
        idempotencyKey,
        senderWalletTxnId: debit.transactionId,
        receiverWalletTxnId: creditTxnId,
        metadata: { giftName: gift.name } as Prisma.InputJsonValue,
      });

      await this.afterSend(gift, txn);
      return txn;
    } catch (err) {
      await this.compensate(
        idempotencyKey,
        senderId,
        dto.receiverId,
        totalNum,
        earningsNum,
        creditTxnId,
      );
      throw err;
    }
  }

  async history(userId: string, q: GiftHistoryDto): Promise<Paginated<unknown>> {
    const where: Prisma.GiftTransactionWhereInput = {
      OR: [{ senderId: userId }, { receiverId: userId }],
      ...(q.contextId ? { contextId: q.contextId } : {}),
    };
    const [rows, total] = await this.repo.listTransactions(where, q.skip, q.limit);
    return buildPaginated(
      rows.map((t) => this.toView(t)),
      total,
      q.page,
      q.limit,
    );
  }

  // ---- Internals ----

  private giftConfig(): GiftConfig {
    return this.config.get('gift') as GiftConfig;
  }

  /** Validate the send context and that both parties belong to it. */
  private async assertContext(
    contextType: GiftContextType,
    contextId: string,
    senderId: string,
    receiverId: string,
  ): Promise<void> {
    if (contextType !== GiftContextType.AUDIO_ROOM) {
      throw new BusinessException(
        ERROR_CODES.GIFT_CONTEXT_INVALID,
        'Gifting is not yet supported in this context.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!(await this.rooms.isRoomLive(contextId))) {
      throw new BusinessException(
        ERROR_CODES.GIFT_CONTEXT_INVALID,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    // Sender must be an active member (throws NOT_ROOM_MEMBER otherwise).
    await this.rooms.assertMember(contextId, senderId);
    const receiverInRoom = await this.rooms.isMember(contextId, receiverId);
    const receiverExists = receiverInRoom && (await this.users.findById(receiverId));
    if (!receiverExists) {
      throw new BusinessException(
        ERROR_CODES.GIFT_RECEIVER_INVALID,
        'The recipient is not in this room.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** Roll a lucky multiplier for LUCKY gifts (fair, crypto-random). */
  private rollLucky(gift: Gift): { multiplier: number; win: boolean } {
    if (
      gift.type !== GiftType.LUCKY ||
      gift.luckyMultipliers.length === 0 ||
      gift.luckyWinChanceBp <= 0
    ) {
      return { multiplier: 1, win: false };
    }
    if (randomInt(0, 10_000) < gift.luckyWinChanceBp) {
      const idx = randomInt(0, gift.luckyMultipliers.length);
      return { multiplier: Math.max(1, gift.luckyMultipliers[idx]), win: true };
    }
    return { multiplier: 1, win: false };
  }

  /** Post-persist side effects: leaderboards, events, and durable jobs. */
  private async afterSend(gift: Gift, txn: GiftTransaction): Promise<void> {
    const totalNum = Number(txn.totalCoinValue);
    const earningsNum = Number(txn.creatorEarnings);

    await this.leaderboards.record({
      contextId: txn.contextId,
      senderId: txn.senderId,
      receiverId: txn.receiverId,
      giftValue: totalNum,
      receiverEarnings: earningsNum,
    });

    await this.bus.publish(
      new GiftSentEvent({
        transactionId: txn.id,
        senderId: txn.senderId,
        receiverId: txn.receiverId,
        giftId: txn.giftId,
        giftType: txn.giftType,
        giftName: gift.name,
        contextType: txn.contextType,
        contextId: txn.contextId,
        quantity: txn.quantity,
        comboTier: txn.comboTier,
        unitCoinValue: txn.unitCoinValue,
        totalCoinValue: totalNum,
        creatorEarnings: earningsNum,
        luckyMultiplier: txn.luckyMultiplier,
        isLuckyWin: txn.isLuckyWin,
        senderExp: txn.senderExp,
        receiverExp: txn.receiverExp,
        createdAt: txn.createdAt.toISOString(),
      }),
    );
    if (txn.comboTier > 1) {
      await this.bus.publish(
        new GiftComboEvent({
          contextType: txn.contextType,
          contextId: txn.contextId,
          senderId: txn.senderId,
          giftId: txn.giftId,
          comboTier: txn.comboTier,
        }),
      );
    }
    if (txn.isLuckyWin) {
      await this.bus.publish(
        new GiftLuckyWinEvent({
          contextType: txn.contextType,
          contextId: txn.contextId,
          senderId: txn.senderId,
          giftId: txn.giftId,
          luckyMultiplier: txn.luckyMultiplier,
          totalCoinValue: totalNum,
        }),
      );
    }

    await this.queue.enqueue(QUEUE_NAMES.GIFT_PROCESSING, 'gift.sent', { transactionId: txn.id });
    await this.queue.enqueue(QUEUE_NAMES.NOTIFICATIONS, 'gift.received', {
      userId: txn.receiverId,
      senderId: txn.senderId,
      giftId: txn.giftId,
      transactionId: txn.id,
    });
    await this.queue.enqueue(QUEUE_NAMES.RANKING_PROCESSING, 'gift.ranking', {
      transactionId: txn.id,
      contextId: txn.contextId,
    });
    await this.queue.enqueue(QUEUE_NAMES.ANALYTICS_PROCESSING, 'gift.sent', {
      transactionId: txn.id,
      senderId: txn.senderId,
      receiverId: txn.receiverId,
      totalCoinValue: totalNum,
    });
  }

  /** Refund coins when the ledger write fails, so a send is all-or-nothing. */
  private async compensate(
    idempotencyKey: string,
    senderId: string,
    receiverId: string,
    totalNum: number,
    earningsNum: number,
    creditTxnId: string | null,
  ): Promise<void> {
    try {
      if (creditTxnId) {
        await this.wallet.debit({
          userId: receiverId,
          currency: WalletCurrency.EARNINGS,
          amount: earningsNum > 0 ? earningsNum : 1,
          reason: WalletTxnReason.GIFT_REFUND,
          idempotencyKey: `gift-credit-reverse:${idempotencyKey}`,
          referenceType: GIFT_WALLET_REFERENCE_TYPE,
          actorId: senderId,
        });
      }
      await this.wallet.credit({
        userId: senderId,
        currency: WalletCurrency.GOLD,
        amount: totalNum,
        reason: WalletTxnReason.GIFT_REFUND,
        idempotencyKey: `gift-debit-reverse:${idempotencyKey}`,
        referenceType: GIFT_WALLET_REFERENCE_TYPE,
        actorId: senderId,
      });
    } catch (err) {
      // A failed compensation must be visible for manual reconciliation.
      this.logger.error(
        `Gift compensation failed for key ${idempotencyKey}: ${(err as Error).message}`,
      );
    }
  }

  private toView(t: GiftTransaction) {
    return {
      id: t.id,
      senderId: t.senderId,
      receiverId: t.receiverId,
      giftId: t.giftId,
      giftType: t.giftType,
      contextType: t.contextType,
      contextId: t.contextId,
      quantity: t.quantity,
      comboTier: t.comboTier,
      totalCoinValue: Number(t.totalCoinValue),
      creatorEarnings: Number(t.creatorEarnings),
      isLuckyWin: t.isLuckyWin,
      luckyMultiplier: t.luckyMultiplier,
      status: t.status,
      createdAt: t.createdAt,
    };
  }
}
