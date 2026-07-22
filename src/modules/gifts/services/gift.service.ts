import { randomInt, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Gift,
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
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { QueueService } from 'src/infra/queue/queue.service';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { VIP_SERVICE, type IVipService } from 'src/modules/vip/interfaces/vip.service.interface';
import { GIFT_WALLET_REFERENCE_TYPE } from '../constants/gifts.constants';
import { walletLockKey } from 'src/modules/wallet/constants/wallet.constants';
import type { GiftHistoryDto, SendGiftDto } from '../dto/gift.dto';
import { GiftComboEvent, GiftLuckyWinEvent, GiftSentEvent } from '../events/gift.events';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import type { GiftContextRequest } from '../interfaces/gift-context-handler.interface';
import { GiftRepository } from '../repositories/gift.repository';
import { GiftCatalogService } from './gift-catalog.service';
import { GiftContextRegistry } from './gift-context.registry';
import { GiftLeaderboardService } from './gift-leaderboard.service';

/**
 * A multi-receiver send. Same shape as SendGiftDto but with `receiverIds` in
 * place of `receiverId`, plus an optional caller-supplied `batchId` so an
 * orchestrating module can correlate the batch with its own records.
 */
export type SendGiftBatchDto = Omit<SendGiftDto, 'receiverId'> & {
  receiverIds: string[];
  batchId?: string;
};

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
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(VIP_SERVICE) private readonly vip: IVipService,
    private readonly registry: GiftContextRegistry,
  ) {}

  /**
   * Single-receiver send. A thin wrapper over `sendGiftBatch` so audio rooms and
   * video rooms share one pipeline and cannot drift apart.
   */
  async sendGift(actor: RoomActor, dto: SendGiftDto): Promise<GiftTransaction> {
    const [txn] = await this.sendGiftBatch(actor, {
      ...dto,
      receiverIds: [dto.receiverId],
    });
    return txn;
  }

  /**
   * Send one gift to N receivers as a single all-or-nothing operation: one debit
   * for the summed total, one credit per receiver, one ledger row per receiver,
   * all inside one transaction. If any receiver fails validation the whole batch
   * rolls back, so the sender is never charged an amount other than the quote.
   */
  async sendGiftBatch(actor: RoomActor, dto: SendGiftBatchDto): Promise<GiftTransaction[]> {
    const cfg = this.giftConfig();
    const senderId = actor.id;

    // De-duplicate first: a client sending ["u1","u1"] means one gift to u1, not
    // a double charge. Dedup before the self-check so both see the same set.
    const receiverIds = [...new Set(dto.receiverIds)];
    if (receiverIds.length === 0) {
      throw new BusinessException(
        ERROR_CODES.GIFT_RECEIVER_INVALID,
        'A gift needs at least one recipient.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (receiverIds.includes(senderId)) {
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
    // A batch's ledger keys are suffixed per receiver; a single send keeps the
    // bare key so existing rows and client replays stay valid.
    const isBatch = receiverIds.length > 1;
    const ledgerKeyFor = (receiverId: string) =>
      isBatch ? `${idempotencyKey}:${receiverId}` : idempotencyKey;

    // Idempotent replay: a prior send with this key returns the original rows.
    const prior = await this.repo.findTxnByIdempotencyKey(ledgerKeyFor(receiverIds[0]));
    if (prior) return [prior];

    // The context handler owns everything room-shaped: what makes this send
    // legal, and how the coins are split. GiftService stays economy-only.
    const handler = this.registry.for(dto.contextType);
    if (receiverIds.length > handler.maxReceivers) {
      throw new BusinessException(
        ERROR_CODES.GIFT_TOO_MANY_RECEIVERS,
        `This context accepts at most ${handler.maxReceivers} recipient(s) per gift.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const req: GiftContextRequest = {
      contextType: dto.contextType,
      contextId: dto.contextId,
      senderId,
      receiverIds,
      gift,
      quantity: dto.quantity,
    };
    await handler.validate(req);

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

    // Economics. Each receiver gets a whole gift, so `perReceiver` is the unit
    // of value and the sender pays it N times. The split is the handler's call,
    // expressed in basis points.
    const unit = gift.coinValue;
    const perReceiver = BigInt(unit) * BigInt(dto.quantity) * BigInt(lucky.multiplier);
    const earningsBps = BigInt(Math.round(handler.economics(req).receiverEarningsBps));
    const creatorEarnings = (perReceiver * earningsBps) / 10_000n;
    const perReceiverNum = Number(perReceiver);
    const totalNum = perReceiverNum * receiverIds.length;
    const earningsNum = Number(creatorEarnings);
    const senderExp = Math.floor(perReceiverNum * cfg.senderExpPerCoin);
    const receiverExp = Math.floor(perReceiverNum * cfg.receiverExpPerCoin);

    // Every lock the send needs, sorted before acquisition. With N receivers,
    // unsorted acquisition across concurrent sends deadlocks; sorting gives the
    // whole system one global lock order.
    const locksToAcquire = [
      ...[senderId, ...receiverIds].map(walletLockKey),
      ...(handler.contextLockKeys?.(req) ?? []),
    ].sort();

    const txnId = randomUUID();
    const batchId = dto.batchId ?? txnId;
    const eventsToPublish: any[] = [];
    let postCommitFn: (() => Promise<void>) | undefined;

    const transactionResult = await this.withLocks(locksToAcquire, () =>
      this.prisma.$transaction(async (tx) => {
        // Re-check idempotency inside the transaction: two concurrent requests
        // with the same key can both pass the pre-flight check above.
        const existingPrior = await this.repo.findTxnByIdempotencyKey(
          ledgerKeyFor(receiverIds[0]),
          tx,
        );
        if (existingPrior) return [existingPrior];

        // 1. Debit the sender for the full amount.
        const debit = await this.wallet.debit(
          {
            userId: senderId,
            currency: WalletCurrency.GOLD,
            amount: totalNum,
            reason: WalletTxnReason.GIFT_SEND,
            idempotencyKey: `gift-debit:${idempotencyKey}`,
            referenceType: GIFT_WALLET_REFERENCE_TYPE,
            metadata: {
              giftId: gift.id,
              quantity: dto.quantity,
              contextId: dto.contextId,
              batchId,
            },
            actorId: senderId,
          },
          tx,
        );

        // 2. Context-specific coin routing (audio rooms: treasure box + host
        //    reward + overflow refund). Postgres-only; its events and postCommit
        //    are drained after the transaction commits.
        const effects = handler.onSend
          ? await handler.onSend(tx, {
              ...req,
              transactionId: txnId,
              batchId,
              idempotencyKey,
              totalCoinValue: totalNum,
            })
          : { acceptedAmount: totalNum, refundAmount: 0, events: [] };
        eventsToPublish.push(...effects.events);
        postCommitFn = effects.postCommit;

        // 3. One credit + one ledger row per receiver. The wallet idempotency key
        //    MUST carry the receiver id: sharing one key across the batch would
        //    make the wallet treat legs 2..N as replays of leg 1 and pay nobody
        //    but the first receiver, while the sender is debited for all N.
        const rows: GiftTransaction[] = [];
        for (const receiverId of receiverIds) {
          let creditTxnId: string | null = null;
          if (earningsNum > 0) {
            const creditResult = await this.wallet.credit(
              {
                userId: receiverId,
                currency: WalletCurrency.EARNINGS,
                amount: earningsNum,
                reason: WalletTxnReason.GIFT_RECEIVE,
                idempotencyKey: `gift-credit:${idempotencyKey}:${receiverId}`,
                referenceType: GIFT_WALLET_REFERENCE_TYPE,
                metadata: { giftId: gift.id, senderId, batchId },
                actorId: senderId,
              },
              tx,
            );
            creditTxnId = creditResult.transactionId;
          }

          rows.push(
            await this.repo.createTransaction(
              {
                senderId,
                receiverId,
                giftId: gift.id,
                giftType: gift.type,
                contextType: dto.contextType,
                contextId: dto.contextId,
                quantity: dto.quantity,
                comboTier,
                unitCoinValue: unit,
                totalCoinValue: perReceiver,
                creatorEarnings,
                luckyMultiplier: lucky.multiplier,
                isLuckyWin: lucky.win,
                senderExp,
                receiverExp,
                idempotencyKey: ledgerKeyFor(receiverId),
                senderWalletTxnId: debit.transactionId,
                receiverWalletTxnId: creditTxnId,
                metadata: {
                  giftName: gift.name,
                  batchId,
                  acceptedAmount: effects.acceptedAmount,
                  refundAmount: effects.refundAmount,
                } as Prisma.InputJsonValue,
              },
              tx,
            ),
          );
        }
        return rows;
      }),
    );

    // Post-commit side effects — leaderboards, events, durable jobs. Every one
    // of these is deliberately outside the transaction: Redis writes cannot roll
    // back, and a queued job could otherwise be picked up before the commit.
    for (const txn of transactionResult) {
      await this.afterSend(gift, txn);
    }

    // Publish all collected treasure / refund events
    for (const event of eventsToPublish) {
      await this.bus.publish(event);
    }

    if (postCommitFn) {
      await postCommitFn();
    }

    return transactionResult;
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

  /**
   * Acquire every lock in order, innermost callback last. Folding avoids the
   * hand-nested `withLock` pyramid and, more importantly, works for any number
   * of locks — which multi-receiver sends need.
   */
  private withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    return keys.reduceRight<() => Promise<T>>(
      (next, key) => () => this.locks.withLock(key, next),
      fn,
    )();
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
