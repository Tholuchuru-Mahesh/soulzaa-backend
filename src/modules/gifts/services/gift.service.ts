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
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { QueueService } from 'src/infra/queue/queue.service';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import {
  WEALTH_SERVICE,
  type IWealthService,
} from 'src/modules/wealth/interfaces/wealth.service.interface';
import { GIFT_WALLET_REFERENCE_TYPE } from '../constants/gifts.constants';
import { walletLockKey } from 'src/modules/wallet/constants/wallet.constants';

import type { GiftHistoryDto, SendGiftDto } from '../dto/gift.dto';
import {
  GiftComboEvent,
  GiftLuckyWinEvent,
  GiftReceivedEvent,
  GiftSentEvent,
} from '../events/gift.events';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import type { GiftContextRequest } from '../interfaces/gift-context-handler.interface';
import { GiftRepository } from '../repositories/gift.repository';
import { GiftCatalogService } from './gift-catalog.service';
import {
  PLATFORM_CONFIG,
  type IPlatformConfiguration,
} from 'src/modules/platform-configuration/interfaces/platform-configuration.interface';
import { GiftContextRegistry } from './gift-context.registry';
import { GiftLeaderboardService } from './gift-leaderboard.service';
import { LeaderboardPeriod } from '../constants/gifts.constants';
import type { TopFanEntry } from '../interfaces/gifts.service.interface';

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
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';

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
    private readonly media: MediaUrlResolver,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(WEALTH_SERVICE) private readonly wealth: IWealthService,
    private readonly registry: GiftContextRegistry,
    @Inject(PLATFORM_CONFIG) private readonly platformConfig: IPlatformConfiguration,
  ) {}

  /** GIFTS_SERVICE surface: total gift coins received in a context within a window. */
  getContextCoinsInRange(
    contextType: GiftContextType,
    contextId: string,
    start: Date,
    end: Date,
  ): Promise<bigint> {
    return this.repo.sumContextCoinsInRange(contextType, contextId, start, end);
  }

  /** GIFTS_SERVICE surface: ranked fans for one creator, with count/lastGiftAt. */
  async getTopFans(
    creatorId: string,
    period: 'today' | 'week' | 'month' | 'all',
    limit: number,
  ): Promise<TopFanEntry[]> {
    const mapped: Record<typeof period, LeaderboardPeriod> = {
      today: LeaderboardPeriod.DAILY,
      week: LeaderboardPeriod.WEEKLY,
      month: LeaderboardPeriod.MONTHLY,
      all: LeaderboardPeriod.ALL_TIME,
    };
    const lbPeriod = mapped[period];
    const ranked = await this.leaderboards.topFans(creatorId, lbPeriod, limit);
    if (ranked.length === 0) return [];

    const since = this.leaderboards.periodStart(lbPeriod);
    const stats = await this.repo.fanStatsFor(
      creatorId,
      ranked.map((r) => r.userId),
      since,
    );
    return ranked.map((r) => ({
      rank: r.rank,
      userId: r.userId,
      totalCoins: r.totalCoins,
      giftCount: stats.get(r.userId)?.count ?? 0,
      lastGiftAt: stats.get(r.userId)?.lastGiftAt ?? null,
    }));
  }

  /**
   * The Soulzaa gift settlement rule, read from platform configuration so a
   * Super Admin can retune it without a deploy:
   *  - the receiver's EARNINGS (Soul Gems / diamond) wallet takes
   *    `earningsPercent` — the **creator conversion rate** — of gift value;
   *  - their GOLD wallet takes `cashbackPercent`, but only once the gift value
   *    is strictly above `cashbackThreshold`.
   * Defaults match the seeded settings, so an unconfigured environment behaves
   * exactly as a configured one.
   *
   * ---- Economy formulas (Gold Coins → Soul Gems → Cash) ----------------
   *
   * "Gold Coins" here always means gifting value: the coin worth of gifts a
   * creator has received (`originalGiftValue` below), never a raw wallet
   * balance. The creator conversion rate below is what turns that gifting
   * value into Soul Gems.
   *
   * 1. Coin → Diamond (Soul Gems), IMPLEMENTED (this method + the credit in
   *    `sendGiftBatch` below):
   *      soulGems = floor(giftingValueCoins × creatorConversionRatePercent / 100)
   *    e.g. 250 gifting-value coins at the default 50% rate → 125 Soul Gems.
   *    `creatorConversionRatePercent` is `gift.receiver_earnings_percentage`
   *    (default 50), edited by a Super Admin via the generic
   *    `PUT /super-admin/configuration/settings/gift.receiver_earnings_percentage`
   *    endpoint — never hardcoded here. The rate actually applied to each gift
   *    is snapshotted onto `GiftTransaction.appliedEarningsPct`, so a later
   *    rate change never rewrites the value of a past gift.
   *
   * 2. Diamond (Soul Gems) → Cash, NOT YET IMPLEMENTED (no withdrawal feature
   *    exists yet — this is the intended shape for when one is built):
   *      cashAmount = soulGemsBalance × diamondToCashRate
   *    `diamondToCashRate` would be a second Super Admin-configurable
   *    platform setting (e.g. `wallet.diamond_to_cash_rate`), read the exact
   *    same way via `platformConfig.getNumber(...)` — no separate mechanism
   *    needed. `WalletTxnReason` already reserves `DIAMOND_GIFT_EARNING` (the
   *    Soul Gems credit itself, step 1) and `GIFT_CASHBACK` (the separate GOLD
   *    cashback below) as distinct ledger reasons for exactly this purpose, so
   *    a future withdrawal flow can debit the diamond wallet with a matching
   *    dedicated reason and read `GiftTransaction.creatorEarnings` /
   *    `Wallet.diamondBalance` directly — both already accumulate correctly
   *    today with no further changes required.
   */
  private async settlementRules(): Promise<{
    earningsPercent: number;
    cashbackPercent: number;
    cashbackThreshold: number;
  }> {
    const [earningsPercent, cashbackPercent, cashbackThreshold] = await Promise.all([
      // The creator conversion rate (Gold-Coin gifting value → Soul Gems).
      // Default 50 lives once, here — matches the seeded `PlatformSetting`
      // row exactly, so an unconfigured environment still behaves correctly.
      // See the formula doc above.
      this.platformConfig.get<any>('gift.receiver_earnings_percentage', 50).catch(() => 50),
      this.platformConfig.get<any>('gift.receiver_cashback_percentage').catch(() => 10),
      this.platformConfig.get<any>('gift.receiver_cashback_threshold').catch(() => 1000),
    ]);

    const earnNum = earningsPercent != null ? Number(earningsPercent) : 50;
    const cashNum = cashbackPercent != null ? Number(cashbackPercent) : 10;
    const threshNum = cashbackThreshold != null ? Number(cashbackThreshold) : 1000;

    return {
      earningsPercent: !isNaN(earnNum) && earnNum > 0 ? earnNum : 50,
      cashbackPercent: !isNaN(cashNum) ? cashNum : 10,
      cashbackThreshold: !isNaN(threshNum) ? threshNum : 1000,
    };
  }

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
    // a double charge.
    const receiverIds = [...new Set(dto.receiverIds)];
    if (receiverIds.length === 0) {
      throw new BusinessException(
        ERROR_CODES.GIFT_RECEIVER_INVALID,
        'A gift needs at least one recipient.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const gift = await this.catalog.getGiftById(dto.giftId);
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

    // Wealth-Level-exclusive gate: the sender's level must meet the gift's minimum.
    // `minVipLevel` values are reinterpreted as-is against the new 0-12 level scale.
    if (
      gift.minVipLevel > 0 &&
      (await this.wealth.getEffectiveLevel(senderId)) < gift.minVipLevel
    ) {
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

    // Universal Soulzaa Gift Settlement Workflow (rates from platform config):
    // 1. Sender pays 100% of the gift value (totalNum) from Available Balance (GOLD).
    // 2. Receiver EARNINGS (Soul Gems) increases by the creator conversion
    //    rate's share of the gifting value, with no further conditions.
    // 3. Receiver Available Balance (GOLD) receives the configured cashback
    //    share, and only once gift value is strictly above the threshold.
    const rules = await this.settlementRules();
    const unit = gift.coinValue;
    const perReceiver = BigInt(unit) * BigInt(dto.quantity) * BigInt(lucky.multiplier);
    const perReceiverNum = Number(perReceiver);
    const totalNum = perReceiverNum * receiverIds.length;
    // "Gold Coins" (gifting value): the coin worth of gifts this receiver got
    // from this send — what the creator conversion rate below applies to.
    const originalGiftValue = perReceiverNum;

    // Rule 2 — Coin → Diamond (Soul Gems): soulGems = giftingValueCoins ×
    // creatorConversionRatePercent / 100 (see the formula doc on
    // `settlementRules` above). The `=== 100` branch is just the identity
    // case of that same formula (skips a multiply/floor that would no-op).
    const earningsNum =
      rules.earningsPercent === 100
        ? originalGiftValue
        : Math.floor((originalGiftValue * rules.earningsPercent) / 100);
    // Soul Gems earned by the creator from this gift — credited to the
    // DIAMOND wallet below, and this exact value is what accumulates into
    // `Wallet.diamondBalance` / the "Soul Gems" figure shown in the app.
    const creatorEarnings = BigInt(earningsNum);

    // Rule 3: Receiver Available Balance (GOLD) receives 10% cashback ONLY IF originalGiftValue >= 1000.
    const availableBalanceCredited =
      originalGiftValue >= rules.cashbackThreshold
        ? Math.floor((originalGiftValue * rules.cashbackPercent) / 100)
        : 0;

    const senderExp = Math.floor(perReceiverNum * cfg.senderExpPerCoin);
    const receiverExp = Math.floor(perReceiverNum * cfg.receiverExpPerCoin);

    // Every lock the send needs. `withLocks` owns de-duplication and ordering —
    // a self-gift puts the sender's wallet key in here twice, and overlapping
    // sender/receiver sets are legal generally, so this list is deliberately raw.
    const locksToAcquire = [
      ...[senderId, ...receiverIds].map(walletLockKey),
      ...(handler.contextLockKeys?.(req) ?? []),
    ];

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

        // 1. Debit the sender for the full amount (100% of gift value).
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

        // 2. Context-specific coin routing (audio/video rooms: treasure box + host
        //    reward + overflow refund, PK scoring, etc.).
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

        // 3. Settle receiver wallet accounts & create immutable gift transaction rows.
        const rows: GiftTransaction[] = [];
        for (const receiverId of receiverIds) {
          let creditTxnId: string | null = null;
          // Step 3a: Receiver Earnings += 100% of gift value (Rule 1)
          if (earningsNum > 0) {
            const creditResult = await this.wallet.credit(
              {
                userId: receiverId,
                currency: WalletCurrency.DIAMOND,
                amount: earningsNum,
                reason: WalletTxnReason.GIFT_RECEIVE,
                idempotencyKey: `gift-credit-earnings:${idempotencyKey}:${receiverId}`,
                referenceType: GIFT_WALLET_REFERENCE_TYPE,
                metadata: { giftId: gift.id, senderId, batchId, giftValue: perReceiverNum },
                actorId: senderId,
              },
              tx,
            );
            creditTxnId = creditResult.transactionId;
          }

          // Step 3b: Receiver Available Balance += 10% ONLY IF giftValue > 1000 (Rule 2 & Rule 3)
          if (availableBalanceCredited > 0) {
            await this.wallet.credit(
              {
                userId: receiverId,
                currency: WalletCurrency.GOLD,
                amount: availableBalanceCredited,
                reason: WalletTxnReason.GIFT_RECEIVE,
                idempotencyKey: `gift-credit-available:${idempotencyKey}:${receiverId}`,
                referenceType: GIFT_WALLET_REFERENCE_TYPE,
                metadata: {
                  giftId: gift.id,
                  senderId,
                  batchId,
                  giftValue: perReceiverNum,
                  availableBalanceCredited,
                },
                actorId: senderId,
              },

              tx,
            );
          }
          const createdRow = await this.repo.createTransaction(
            {
              id: isBatch ? randomUUID() : txnId,
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
              cashbackAmount: BigInt(availableBalanceCredited),
              appliedEarningsPct: rules.earningsPercent,
              appliedCashbackPct: rules.cashbackPercent,
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
          );
          rows.push(createdRow);

          this.logger.log(
            `[Gift Settle] Txn: ${createdRow.id}, Context: ${dto.contextType}:${dto.contextId}, Sender: ${senderId}, Wallet credited recipient: ${receiverId}, Earnings (Gems): ${earningsNum}, Cashback (Gold): ${availableBalanceCredited}, Total Coin Value: ${perReceiverNum}`,
          );

          if (gift.type === GiftType.PROFILE_FRAME) {
            let cosmetic = await tx.cosmetic.findFirst({
              where: { type: 'FRAME', name: gift.name },
            });
            if (!cosmetic) {
              cosmetic = await tx.cosmetic.create({
                data: {
                  type: 'FRAME',
                  name: gift.name,
                  mediaUrl: gift.animationUrl || gift.thumbnailUrl || 'default_pink_frame',
                  thumbnailUrl: gift.thumbnailUrl,
                  price: gift.coinValue,
                  enabled: true,
                  isPremium: true,
                },
              });
            }

            let expiresAt: Date | null = null;
            const ttlVal = gift.ttlValue || 0;
            if (ttlVal > 0) {
              let durationMs = 0;
              const ttlUnit = (gift.ttlUnit || 'DAYS').toUpperCase();
              if (ttlUnit === 'SECONDS') durationMs = ttlVal * 1000;
              else if (ttlUnit === 'MINUTES') durationMs = ttlVal * 60 * 1000;
              else if (ttlUnit === 'HOURS') durationMs = ttlVal * 60 * 60 * 1000;
              else durationMs = ttlVal * 24 * 60 * 60 * 1000;
              expiresAt = new Date(Date.now() + durationMs);
            }

            const existing = await tx.userCosmetic.findUnique({
              where: { userId_cosmeticId: { userId: receiverId, cosmeticId: cosmetic.id } },
            });

            if (existing) {
              if (expiresAt) {
                if (existing.expiresAt) {
                  const baseTime =
                    existing.expiresAt.getTime() > Date.now()
                      ? existing.expiresAt.getTime()
                      : Date.now();
                  const newExpires = new Date(baseTime + (expiresAt.getTime() - Date.now()));
                  await tx.userCosmetic.update({
                    where: { id: existing.id },
                    data: {
                      expiresAt: newExpires,
                    },
                  });
                }
              } else {
                // If the new gift is permanent, make the ownership permanent by clearing expiresAt!
                await tx.userCosmetic.update({
                  where: { id: existing.id },
                  data: {
                    expiresAt: null,
                  },
                });
              }
            } else {
              await tx.userCosmetic.create({
                data: {
                  userId: receiverId,
                  cosmeticId: cosmetic.id,
                  equipped: false,
                  expiresAt,
                },
              });
            }
          }
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
      ...(q.contextType ? { contextType: q.contextType } : {}),
    };
    const [rows, total] = await this.repo.listTransactions(where, q.skip, q.limit);

    const giftIds = [...new Set(rows.map((r) => r.giftId))];
    const userIds = [
      ...new Set([...rows.map((r) => r.senderId), ...rows.map((r) => r.receiverId)]),
    ];

    const [gifts, users] = await Promise.all([
      giftIds.length > 0 ? this.prisma.gift.findMany({ where: { id: { in: giftIds } } }) : [],
      userIds.length > 0
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [],
    ]);

    const resolvedGifts = await Promise.all(
      gifts.map(async (g) => {
        const thumbKey =
          g.thumbnailUrl || (g as any).iconUrl || g.lottieUrl || g.animationUrl || null;
        const animKey =
          g.animationUrl || g.lottieUrl || g.svgaUrl || g.mp4Url || (g as any).mediaUrl || null;
        return {
          ...g,
          resolvedThumbnailUrl: thumbKey ? await this.media.resolve(thumbKey) : null,
          resolvedAnimationUrl: animKey ? await this.media.resolve(animKey) : null,
        };
      }),
    );

    const giftMap = new Map(resolvedGifts.map((g) => [g.id, g]));
    const userMap = new Map(users.map((u) => [u.id, u]));

    const enriched = rows.map((t) => {
      const gift = giftMap.get(t.giftId);
      const sender = userMap.get(t.senderId);
      const receiver = userMap.get(t.receiverId);

      return {
        ...this.toView(t),
        giftName: gift?.displayName || gift?.name || 'Gift',
        giftThumbnailUrl:
          gift?.resolvedThumbnailUrl || gift?.thumbnailUrl || (gift as any)?.iconUrl || null,
        giftAnimationUrl:
          gift?.resolvedAnimationUrl || gift?.animationUrl || (gift as any)?.mediaUrl || null,
        senderName: sender?.fullName || sender?.username || null,
        senderUsername: sender?.username || null,
        receiverName: receiver?.fullName || receiver?.username || null,
        receiverUsername: receiver?.username || null,
      };
    });

    return buildPaginated(enriched, total, q.page, q.limit);
  }

  // ---- Internals ----

  private giftConfig(): GiftConfig {
    return this.config.get('gift') as GiftConfig;
  }

  /**
   * Acquire every DISTINCT lock, in a globally consistent order, innermost
   * callback last. Folding avoids the hand-nested `withLock` pyramid and works
   * for any number of locks — which multi-receiver sends need.
   *
   * De-duplication is not a tidy-up, it is load-bearing. `LockService.withLock`
   * is a Redis SET-NX lock and therefore NOT reentrant, so a key appearing twice
   * would be nested inside itself: the inner acquire can never succeed while the
   * outer holds it, and the send dies ~2.1s later on the retry budget. A
   * self-gift does exactly that — sender and receiver are one wallet, so the
   * same key arrives twice. Sorting stays for the other half of the contract:
   * one global acquisition order, so concurrent sends cannot deadlock each other.
   */
  private withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    return [...new Set(keys)]
      .sort()
      .reduceRight<() => Promise<T>>((next, key) => () => this.locks.withLock(key, next), fn)();
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
    await this.bus.publish(
      new GiftReceivedEvent({
        transactionId: txn.id,
        userId: txn.receiverId,
        receiverId: txn.receiverId,
        senderId: txn.senderId,
        giftId: txn.giftId,
        giftName: gift.name,
        quantity: txn.quantity,
        totalCoinValue: totalNum,
        creatorEarnings: earningsNum,
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
