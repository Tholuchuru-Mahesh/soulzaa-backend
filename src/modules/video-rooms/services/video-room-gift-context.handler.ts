import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GiftContextType, Prisma, VideoRoomMemberRole, VideoRoomStatus } from '@prisma/client';
import { EVENT_BUS, type DomainEvent, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import type {
  GiftContextRequest,
  GiftEconomics,
  GiftSendContext,
  GiftSendEffects,
  IGiftContextHandler,
} from 'src/modules/gifts/interfaces/gift-context-handler.interface';
import { GiftContextRegistry } from 'src/modules/gifts/services/gift-context.registry';
import { loadVideoRoomGiftConfig } from '../config/video-room-gift.config';
import { VIDEO_ROOM_TREASURE_QUEUE_JOB } from '../constants/video-room-treasure.constants';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import type { PkScoringResult } from './video-room-pk-scoring.service';
import { VideoRoomPkScoringService } from './video-room-pk-scoring.service';
import { VideoRoomTreasureProgressService } from './video-room-treasure-progress.service';

/** Payload of the `video-room.treasure.unlock` BullMQ job. */
export interface VideoRoomTreasureUnlockJob {
  roomId: string;
  sessionId: string;
  boxId: string;
  level: number;
  correlationId: string;
}

/**
 * The VIDEO_ROOM gift context (VR-10, extended VR-11).
 *
 * `onSend` raises the treasure counter and, when a box fills, claims it. It does
 * NO wallet work: video treasure progress is a counter, not an escrow (VR-11
 * D1), so the send transaction stays a debit, N credits, N ledger rows and one
 * `UPDATE … SET progress = progress + n`. The receiver still earns their VR-10
 * creator share; nothing is double-spent.
 *
 * Gifting is gated by membership + room settings, not by the RBAC permission
 * matrix. That matrix is management-only — HOST/PARTICIPANT/VIEWER all map to
 * empty permission sets — so adding SEND_GIFT there would mean granting it to
 * all six roles, which encodes nothing.
 */
@Injectable()
export class VideoRoomGiftContextHandler implements IGiftContextHandler, OnModuleInit {
  readonly contextType = GiftContextType.VIDEO_ROOM;
  private readonly logger = new Logger(VideoRoomGiftContextHandler.name);

  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly config: ConfigService,
    private readonly registry: GiftContextRegistry,
    private readonly treasureProgress: VideoRoomTreasureProgressService,
    private readonly queue: QueueService,
    private readonly pkScoring: VideoRoomPkScoringService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Configured recipient cap; the resolver also enforces it before we get here. */
  get maxReceivers(): number {
    return loadVideoRoomGiftConfig(this.config).maxReceivers;
  }

  async validate(req: GiftContextRequest): Promise<void> {
    const { contextId: roomId, senderId, receiverIds } = req;

    if (receiverIds.length > this.maxReceivers) {
      throw new BusinessException(
        ERROR_CODES.GIFT_TOO_MANY_RECEIVERS,
        `A gift may target at most ${this.maxReceivers} recipients.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (room.status !== VideoRoomStatus.LIVE) {
      throw new BusinessException(
        ERROR_CODES.GIFT_CONTEXT_INVALID,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }

    const settings = await this.rooms.getSettings(roomId);
    if (settings && !settings.allowGifts) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_GIFTS_DISABLED,
        'Gifting is disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    // A blocked sender may still hold a stale membership row; check explicitly.
    if (await this.moderation.isActivelyBlocked(roomId, senderId)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_BLOCKED,
        'You are blocked from this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    const sender = await this.rooms.getMember(roomId, senderId);
    if (!sender?.isActive) {
      throw new BusinessException(
        ERROR_CODES.NOT_ROOM_MEMBER,
        'You are not in this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    this.assertCountryAllowed(sender.country);

    const allowViewerGifts = this.viewerGiftsAllowed(settings?.metadata);
    for (const receiverId of receiverIds) {
      const receiver = await this.rooms.getMember(roomId, receiverId);
      if (!receiver?.isActive) {
        throw new BusinessException(
          ERROR_CODES.GIFT_RECEIVER_INVALID,
          'A recipient is not in this room.',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!allowViewerGifts && receiver.role === VideoRoomMemberRole.VIEWER) {
        throw new BusinessException(
          ERROR_CODES.GIFT_RECEIVER_INVALID,
          'This room does not allow gifting viewers.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
  }

  /**
   * Video rooms are a host context: the receiver (host) is paid ONCE by the
   * configurable Revenue split (RevenueEventService → RevenueDistributionService),
   * exactly like AUDIO_ROOM. Returning 0 here prevents the double-pay where the
   * gift path AND the revenue split both credited EARNINGS for the same gift.
   */
  economics(_req: GiftContextRequest): GiftEconomics {
    return { receiverEarningsBps: 0 };
  }

  /**
   * Treasure contribution (VR-11) and PK scoring (VR-12), both inside the send
   * transaction.
   *
   * Each is guarded SEPARATELY. A single try/catch around both would mean a
   * treasure fault silently stops PK scoring — two unrelated subsystems sharing
   * one failure domain for no reason. Either can degrade to "gift succeeded,
   * nothing counted" without touching the other, and the combined `postCommit`
   * below applies the same rule to their post-commit halves: each is guarded
   * individually so a Redis/queue fault in one can never skip the other's work.
   *
   * Nothing is escrowed, so the full amount is always accepted and the refund
   * is always zero. Both values are structural here, not conditional on either
   * subsystem's outcome.
   *
   * `onSend` itself makes ZERO Redis calls on any path (review fix): PK's
   * `shouldEmit` throttle used to be awaited right here, inside the gift's own
   * `$transaction` — a Redis blip there aborted an already-paid gift. The
   * throttle decision and the broadcast it gates now both live in
   * `postCommit`, via {@link publishPkEvents}, alongside the mirror write.
   */
  async onSend(tx: Prisma.TransactionClient, ctx: GiftSendContext): Promise<GiftSendEffects> {
    const inert: GiftSendEffects = {
      acceptedAmount: ctx.totalCoinValue,
      refundAmount: 0,
      events: [],
    };

    const treasure = await this.applyTreasure(tx, ctx);
    const pk = await this.applyPk(tx, ctx);

    // Neither subsystem left post-commit work: match the pre-VR-12 contract of
    // an absent `postCommit`, which the treasure-only "no ladder" case already
    // relies on (a room with neither a treasure ladder nor a PK battle is truly
    // inert, not just quiet).
    if (!treasure.postCommit && !pk.mirror) {
      return { ...inert, events: [...treasure.events] };
    }

    return {
      ...inert,
      events: [...treasure.events],
      postCommit: async () => {
        await treasure.postCommit?.().catch((err: unknown) => {
          this.logger.error(
            `Treasure postCommit failed for room ${ctx.contextId}: ${(err as Error).message}`,
          );
        });
        if (pk.mirror) {
          await this.pkScoring.mirror(pk.mirror).catch((err: unknown) => {
            this.logger.warn(
              `PK mirror failed for battle ${pk.mirror!.battleId}: ${(err as Error).message}`,
            );
          });
          await this.publishPkEvents(pk).catch((err: unknown) => {
            this.logger.warn(
              `PK event publish failed for battle ${pk.mirror!.battleId}: ${(err as Error).message}`,
            );
          });
        }
      },
    };
  }

  /**
   * Throttled PK score broadcast, entirely post-commit (review fix for a
   * critical finding: `shouldEmit` reads/writes a Redis key and MUST NOT run
   * inside `onSend`'s transaction). Running the whole decision here means the
   * worst a Redis fault can do is skip one broadcast — it can never fail the
   * gift itself, since `onSend` has already returned and committed by the
   * time this runs.
   *
   * `pk.mirror` is only ever set by `applyPk` when `this.pkScoring.apply`
   * succeeded, so `pk.battleId` is guaranteed non-null whenever this is
   * called (the caller only invokes it under `if (pk.mirror)`).
   */
  private async publishPkEvents(pk: PkScoringResult): Promise<void> {
    if (pk.events.length === 0) return;
    const emit = await this.pkScoring.shouldEmit(pk.battleId!);
    if (!emit) return;
    for (const event of pk.events) {
      await this.bus.publish(event);
    }
  }

  /**
   * Treasure contribution, inside the send transaction (VR-11).
   *
   * Postgres only, per the `GiftSendEffects` contract: the Redis mirror and the
   * unlock enqueue are deferred to `postCommit`, so a rolled-back gift can never
   * schedule a payout.
   *
   * Everything here is best-effort. A treasure fault must never fail a paid
   * gift, so the whole body is guarded and degrades to "gift succeeded, nothing
   * counted" — which is also exactly what a room with no ladder returns.
   */
  private async applyTreasure(
    tx: Prisma.TransactionClient,
    ctx: GiftSendContext,
  ): Promise<{ events: DomainEvent<unknown>[]; postCommit?: () => Promise<void> }> {
    const empty = { events: [] as DomainEvent<unknown>[] };

    try {
      const result = await this.treasureProgress.apply(tx, {
        roomId: ctx.contextId,
        senderId: ctx.senderId,
        amount: ctx.totalCoinValue,
        giftTxnId: ctx.transactionId,
        batchId: ctx.batchId,
      });

      if (!result.sessionId) return empty;

      // A threshold crossing always broadcasts; routine progress is throttled so
      // a hot room cannot fan out hundreds of near-identical updates a second.
      const crossed = result.claimedBoxId !== null;
      const events =
        crossed || (await this.treasureProgress.shouldEmit(ctx.contextId)) ? result.events : [];

      const { sessionId, claimedBoxId, claimedLevel, correlationId, mirror } = result;
      const roomId = ctx.contextId;
      const senderId = ctx.senderId;

      return {
        events,
        postCommit: async () => {
          if (mirror) {
            await this.treasureProgress
              .mirror(roomId, mirror.level, mirror.progress)
              .catch(() => undefined);
          }
          await this.treasureProgress
            .recordActivity(roomId, sessionId, senderId)
            .catch(() => undefined);

          if (claimedBoxId && claimedLevel !== null) {
            await this.queue.enqueue<VideoRoomTreasureUnlockJob>(
              QUEUE_NAMES.GIFT_PROCESSING,
              VIDEO_ROOM_TREASURE_QUEUE_JOB,
              { roomId, sessionId, boxId: claimedBoxId, level: claimedLevel, correlationId },
              // A stable jobId makes a duplicated postCommit idempotent at the
              // queue itself, before the pipeline's own replay guards run.
              { jobId: `treasure-unlock:${claimedBoxId}`, attempts: 5 },
            );
          }
        },
      };
    } catch (err) {
      this.logger.error(
        `Treasure contribution failed for room ${ctx.contextId}: ${(err as Error).message}`,
      );
      return empty;
    }
  }

  /**
   * PK score contribution, inside the same send transaction (VR-12).
   *
   * `VideoRoomPkScoringService.apply` already guards its own body and never
   * throws (idle result on any fault), but the call itself is still wrapped
   * here: this is the boundary that guarantees a PK fault can NEVER reach the
   * treasure call above or the gift's own transaction, independent of whatever
   * `apply`'s internal contract happens to be today.
   */
  private async applyPk(
    tx: Prisma.TransactionClient,
    ctx: GiftSendContext,
  ): Promise<PkScoringResult> {
    const idle: PkScoringResult = { battleId: null, applied: 0, events: [], mirror: null };
    try {
      return await this.pkScoring.apply(tx, {
        roomId: ctx.contextId,
        senderId: ctx.senderId,
        receiverIds: ctx.receiverIds,
        totalCoinValue: ctx.totalCoinValue,
        giftTxnId: ctx.transactionId,
        batchId: ctx.batchId,
      });
    } catch (err) {
      this.logger.warn(`PK scoring failed for room ${ctx.contextId}: ${(err as Error).message}`);
      return idle;
    }
  }

  /**
   * Regulatory country gate. The sender's country is the one captured on their
   * membership row at join time — not a request header — so a client cannot
   * spoof its way past the restriction.
   *
   * Platform-level rather than per-gift: the `gifts` table has neither a country
   * nor a metadata column, so per-gift country rules would require a migration,
   * which this phase forbids. A member with no recorded country is allowed
   * through; blocking on unknown would bar every pre-existing member.
   */
  private assertCountryAllowed(country: string | null | undefined): void {
    if (!country) return;
    const blocked = loadVideoRoomGiftConfig(this.config).blockedCountries;
    if (blocked.includes(country.trim().toUpperCase())) {
      throw new BusinessException(
        ERROR_CODES.GIFT_COUNTRY_RESTRICTED,
        'Gifting is not available in your region.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * Per-room override of viewer gifting, stored in settings metadata (the VR-2
   * precedent for policy flags that don't warrant a column).
   */
  private viewerGiftsAllowed(metadata: unknown): boolean {
    const fallback = loadVideoRoomGiftConfig(this.config).allowViewerGiftsDefault;
    if (!metadata || typeof metadata !== 'object') return fallback;
    const value = (metadata as Record<string, unknown>).allowViewerGifts;
    return typeof value === 'boolean' ? value : fallback;
  }
}
