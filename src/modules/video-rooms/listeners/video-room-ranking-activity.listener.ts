import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { GIFT_EVENTS, type GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { errorMessage } from '../constants/video-room-ranking.constants';
import { VIDEO_ROOM_EVENTS, type RoomClosedEvent } from '../events/video-room.events';
import { VIDEO_ROOM_PK_EVENTS, type PkEndedEvent } from '../events/video-room-pk.events';
import {
  VIDEO_ROOM_TREASURE_EVENTS,
  type TreasureRewardDistributedEvent,
} from '../events/video-room-treasure.events';
import { VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import { VideoRoomRankingService } from '../services/video-room-ranking.service';
import { VideoRoomSeatStateService } from '../services/video-room-seat-state.service';

/**
 * The VR-13 write trigger: every source event that should move a video-room
 * ladder — gifts, PK results, treasure payouts, room closure. (Refunds are
 * deliberately NOT subscribed to here; see the comment at the subscription
 * site in `onModuleInit` for why.)
 *
 * This listener is ADDITIVE to the platform `RankingsActivityListener`
 * (`src/modules/rankings/listeners/rankings-activity.listener.ts`), which
 * ALSO subscribes to `gift.sent` and already maintains the `rankings:*`
 * ladders — including for video-room gifts. The two coexist without
 * double-counting because they write different namespaces: `rankings:*`
 * there, `vrank:*` here (see `VideoRoomRankingService`). Removing either
 * silently drops a whole family of ladders; the platform listener is out of
 * this module's scope and must not be touched.
 *
 * Every handler swallows and logs. These events announce money that has
 * ALREADY moved — a gift delivered, a PK settled, a treasure paid. Throwing
 * back into the bus cannot undo any of that; it can only break the OTHER
 * subscribers reacting to the same event (notifications, EXP, socket
 * bridges), since the bus fans every subscriber out concurrently. Every
 * message interpolated into a catch's log line goes through `errorMessage`,
 * never a bare `(err as Error).message` — a subscriber that rejects with
 * `undefined` (a bare `throw undefined` or an empty `Promise.reject()`)
 * would otherwise throw a NEW TypeError from inside the catch itself,
 * defeating the whole point of swallowing.
 */
@Injectable()
export class VideoRoomRankingActivityListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomRankingActivityListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly rankings: VideoRoomRankingService,
    private readonly seats: VideoRoomSeatStateService,
    private readonly pkRepo: VideoRoomPkRepository,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => this.onGiftSent(e));
    // No `GIFT_EVENTS.REFUNDED` subscription here — deliberately. The only
    // publisher of `gift.refunded` in the codebase is the audio-room gift
    // context handler (`audio-room-gift-context.handler.ts`); video-room
    // gift reversals publish nothing to the bus at all. Even if a video-room
    // refund did fire, `GiftRefundedPayload` carries no `receiverId`, so
    // there is no attributable receiver to credit/debit on a ladder. The
    // periodic recompute filters `status: COMPLETED`, so a reversed
    // transaction simply drops out of the ladders at the next aggregation —
    // that filter is what heals refunds, not this listener. Do not add this
    // subscription back without first giving `GiftRefundedPayload` a real
    // receiver.
    this.bus.subscribe<PkEndedEvent>(VIDEO_ROOM_PK_EVENTS.ENDED, (e) => this.onPkEnded(e));
    this.bus.subscribe<TreasureRewardDistributedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
      (e) => this.onTreasureDistributed(e),
    );
    this.bus.subscribe<RoomClosedEvent>(VIDEO_ROOM_EVENTS.CLOSED, (e) => this.onRoomClosed(e));
  }

  /**
   * Only VIDEO_ROOM gifts are ours. `GiftSentPayload.contextType` is shared
   * across every gift surface on the platform (AUDIO_ROOM, LIVE_STREAM,
   * PRIVATE_CHAT too) — counting those here would corrupt the video-room
   * ladders on top of the platform-wide ones the other listener already
   * maintains correctly for every context.
   */
  private async onGiftSent(event: GiftSentEvent): Promise<void> {
    const p = event.payload;
    if (p.contextType !== 'VIDEO_ROOM') return;
    try {
      await this.rankings.recordGift({
        transactionId: p.transactionId,
        roomId: p.contextId,
        senderId: p.senderId,
        receiverId: p.receiverId,
        totalCoinValue: p.totalCoinValue,
        quantity: p.quantity,
        receiverIsSeated: await this.isSeated(p.contextId, p.receiverId),
        occurredAt: new Date(p.createdAt),
      });
    } catch (err) {
      this.logger.error(`ranking gift.sent failed (${p.transactionId}): ${errorMessage(err)}`);
    }
  }

  /**
   * An unavailable, cold, or missing seat snapshot resolves to `false`, never
   * a throw. Crediting the hosts ladder on a guess would be worse than
   * briefly under-crediting it — the recompute pass recovers the correct
   * value from source rows regardless.
   *
   * Reads `VideoRoomSeatStateService.getSnapshot` directly rather than a
   * dedicated `isSeated` method: no such method exists on that service today,
   * and this task's file scope is the listener (and its spec) only, so none
   * was added there.
   */
  private async isSeated(roomId: string, userId: string): Promise<boolean> {
    try {
      const snapshot = await this.seats.getSnapshot(roomId);
      return snapshot?.seats.some((seat) => seat.occupantUserId === userId) ?? false;
    } catch (err) {
      this.logger.warn(`seat lookup failed for ${userId} in ${roomId}: ${errorMessage(err)}`);
      return false;
    }
  }

  /**
   * `PkEndedEvent`'s payload does not declare `participants` (see
   * `events/video-room-pk.events.ts` — only `PkStartedEvent` does). Widening
   * that shipped event's payload is a larger change than this task should
   * make, so participants are read back here instead.
   *
   * `VideoRoomPkQueryService.getCurrent` was considered first (the brief's
   * suggestion) but rejected: it resolves the battle via
   * `VideoRoomPkRepository.findCurrent`, which explicitly EXCLUDES
   * `COMPLETED`/`CANCELLED`/`FAILED` battles — by the time `pk.ended` fires
   * the battle is already terminal, so that read would always come back
   * empty. `VideoRoomPkRepository.listParticipants(battleId)` is
   * unconditional on status, lives in the same module, and is the smaller
   * read — the query service's `history()` alternative needs an actor +
   * pagination and returns no per-user participant breakdown at all.
   */
  private async onPkEnded(event: PkEndedEvent): Promise<void> {
    const p = event.payload;
    try {
      const participants = await this.pkRepo.listParticipants(p.battleId);
      if (participants.length === 0) return;

      await this.rankings.recordPkResult({
        battleId: p.battleId,
        roomId: p.roomId,
        occurredAt: new Date(event.occurredAt),
        outcomes: participants.map((participant) => ({
          userId: participant.userId,
          // A draw (`isDraw`, `winningTeamId === null`) is neither a win nor
          // a loss for anyone.
          won: !p.isDraw && p.winningTeamId === participant.teamId,
          lost: !p.isDraw && p.winningTeamId !== null && p.winningTeamId !== participant.teamId,
          // Each participant's OWN score, never the team total. The
          // recompute path (`aggregatePkOutcomes` → `entry.score += p.score`)
          // sums each participant's own `VideoRoomPkParticipant.score`; a
          // team's score is the SUM of its participants' scores, so crediting
          // every teammate with the whole team score (the former bug here)
          // over-credits everyone but the sole participant of a ONE_VS_ONE
          // team by the sum of their teammates' scores, and the next
          // recompute steps the PK ladder for every window containing a TEAM
          // battle. `score` is a Prisma BigInt column.
          score: Number(participant.score),
        })),
      });
    } catch (err) {
      this.logger.error(`ranking pk.ended failed (${p.battleId}): ${errorMessage(err)}`);
    }
  }

  /**
   * `TreasureRewardDistributedEvent` already carries exactly ONE winner per
   * event — `VideoRoomTreasureUnlockService` publishes it once per element of
   * `distributed` (see `video-room-treasure-unlock.service.ts`), unlike
   * `TreasureWinnerSelectedEvent`/`TreasureUnlockedEvent`, whose payload IS a
   * `winners: TreasureWinnerPayload[]` array. There is no batch to loop over
   * here — "one win per recipient" falls out of the bus firing once per
   * recipient, not out of code in this handler.
   *
   * `rewardId` is per-winner (`boxId`/`correlationId` + `userId`), never the
   * shared `correlationId`/`walletTxnId` alone: `walletTxnId` can be `null`
   * (see `TreasureRewardDistributedEvent`'s payload), and a shared id across
   * two winners of the same box would dedupe every winner after the first
   * into a silent no-op — the write path claims a dedupe id exactly once.
   */
  private async onTreasureDistributed(event: TreasureRewardDistributedEvent): Promise<void> {
    const p = event.payload;
    try {
      await this.rankings.recordTreasureWin({
        rewardId: `${p.boxId ?? p.correlationId}:${p.userId}`,
        roomId: p.roomId,
        userId: p.userId,
        amount: p.amount,
        occurredAt: new Date(event.occurredAt),
      });
    } catch (err) {
      this.logger.error(
        `ranking treasure distribution failed (${p.correlationId}): ${errorMessage(err)}`,
      );
    }
  }

  /**
   * `RoomClosedEvent`'s real payload is `{ roomId, actorId, ownerId,
   * durationSeconds }` (see `events/video-room.events.ts`) — no `sessionId`,
   * no viewer/PK/treasure counters. `activityId` is keyed on the event's own
   * `eventId` — always present on a real `DomainEvent`, unlike a `sessionId`
   * this payload does not carry — so a redelivery of the same event cannot
   * double count.
   *
   * `durationSeconds` is deliberately NOT forwarded as `avgWatchSeconds`.
   * It's the room's total OPEN time (`Date.now() - room.createdAt`, see
   * `video-room-lifecycle.service.ts`) — independent of viewers or
   * engagement — while `avgWatchSeconds` is a per-viewer average weighted
   * into the ROOMS composite. A room left open 24h with zero viewers would
   * otherwise score as if 86,400 seconds of genuine per-viewer watch time
   * had occurred. No metric is recorded here until a real per-viewer
   * watch-time signal exists; a `room.closed` tick still legitimately marks
   * activity via `activityId` alone.
   */
  private async onRoomClosed(event: RoomClosedEvent): Promise<void> {
    const p = event.payload;
    try {
      await this.rankings.recordRoomActivity({
        activityId: `close:${p.roomId}:${event.eventId}`,
        roomId: p.roomId,
        occurredAt: new Date(event.occurredAt),
      });
    } catch (err) {
      this.logger.error(`ranking room.closed failed (${p.roomId}): ${errorMessage(err)}`);
    }
  }
}
