import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Gift } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  GIFT_COMBO_INDEX_KEY,
  giftComboKey,
  giftComboMember,
  parseGiftComboMember,
} from '../constants/video-room-gift.constants';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import {
  VideoRoomGiftComboEndedEvent,
  VideoRoomGiftComboStartedEvent,
  VideoRoomGiftComboUpdatedEvent,
} from '../events/video-room-gift.events';

/** Result of a combo tick. */
export interface ComboTickResult {
  /** Streak length. Display only — combo never multiplies cost. */
  tier: number;
  /** True on the first tick of a new streak. */
  started: boolean;
}

/** A live combo, as served by `GET /gifts/combo`. */
export interface VideoRoomGiftComboView {
  senderId: string;
  giftId: string;
  tier: number;
  expiresAt: string;
}

/**
 * Combo lifecycle for video-room gifts (VR-10).
 *
 * The tier itself is a Redis counter with the gift's combo window as its TTL, so
 * a lapse resets the streak for free. The lifecycle around it is the new part:
 * `started` and `updated` ride the send, but `ended` has no natural trigger —
 * an expiring Redis key emits nothing. Rather than enable keyspace
 * notifications (a Redis *server* config change, and one that fires
 * best-effort), every live combo is registered in an expiry-scored ZSET that
 * the gift monitor sweeps. Deterministic, testable with an injected clock, and
 * no infrastructure change.
 */
@Injectable()
export class VideoRoomGiftComboService {
  private readonly logger = new Logger(VideoRoomGiftComboService.name);

  constructor(
    private readonly cache: CacheService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
    /** Injected so the expiry sweep is deterministic under test. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Advance the combo for (room, sender, gift) and publish started/updated.
   * Called once per send — never once per receiver: a "gift the stage" send is
   * one user action and must advance the streak by one.
   */
  async tick(
    roomId: string,
    senderId: string,
    gift: Gift,
    totalCoinValue: number,
  ): Promise<ComboTickResult> {
    const windowSeconds = gift.comboWindowSeconds;
    const tier = await this.cache.increment(giftComboKey(roomId, senderId, gift.id), {
      ttlSeconds: windowSeconds,
    });
    const expiresAtMs = this.now() + windowSeconds * 1000;

    // Register/refresh the expiry index so the sweep can close this streak.
    await this.cache.setScore(
      GIFT_COMBO_INDEX_KEY,
      giftComboMember(roomId, senderId, gift.id),
      expiresAtMs,
    );

    const payload = {
      roomId,
      senderId,
      giftId: gift.id,
      comboTier: tier,
      totalCoinValue,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    const started = tier <= 1;
    this.metrics.incGiftCombo(started ? 'started' : 'updated');
    await this.bus.publish(
      started
        ? new VideoRoomGiftComboStartedEvent(payload)
        : new VideoRoomGiftComboUpdatedEvent(payload),
    );

    return { tier, started };
  }

  /**
   * Close every combo whose window has elapsed, publishing `combo_ended`.
   * Returns how many were closed. Driven by the gift monitor's tick.
   */
  async sweepExpired(nowMs: number = this.now()): Promise<number> {
    const expired = await this.cache.sortedRangeByScore(GIFT_COMBO_INDEX_KEY, 0, nowMs);
    if (expired.length === 0) return 0;

    let closed = 0;
    for (const member of expired) {
      const parsed = parseGiftComboMember(member);
      if (!parsed) {
        this.logger.warn(`dropping malformed combo index member: ${member}`);
        continue;
      }
      // The counter itself has already expired by TTL; read best-effort so the
      // ended event can still report the streak the user actually saw.
      const finalTier =
        (await this.cache.get<number>(
          giftComboKey(parsed.roomId, parsed.senderId, parsed.giftId),
        )) ?? 0;

      await this.bus.publish(
        new VideoRoomGiftComboEndedEvent({
          roomId: parsed.roomId,
          senderId: parsed.senderId,
          giftId: parsed.giftId,
          finalTier: Number(finalTier) || 0,
        }),
      );
      this.metrics.incGiftCombo('ended');
      closed += 1;
    }

    // Remove after publishing: a crash mid-sweep replays an ended event, which
    // is harmless, whereas removing first would lose it entirely.
    await this.cache.sortedRemove(GIFT_COMBO_INDEX_KEY, ...expired);
    return closed;
  }

  /** Live combos for a room, for `GET /gifts/combo`. */
  async listActive(roomId: string, nowMs: number = this.now()): Promise<VideoRoomGiftComboView[]> {
    // Everything not yet expired; the index is global, so filter by room.
    const members = await this.cache.sortedRangeByScore(
      GIFT_COMBO_INDEX_KEY,
      nowMs,
      Number.MAX_SAFE_INTEGER,
    );
    const views: VideoRoomGiftComboView[] = [];
    for (const member of members) {
      const parsed = parseGiftComboMember(member);
      if (!parsed || parsed.roomId !== roomId) continue;
      const tier = await this.cache.get<number>(
        giftComboKey(parsed.roomId, parsed.senderId, parsed.giftId),
      );
      if (!tier) continue;
      const score = await this.cache.score(GIFT_COMBO_INDEX_KEY, member);
      views.push({
        senderId: parsed.senderId,
        giftId: parsed.giftId,
        tier: Number(tier),
        expiresAt: new Date(score ?? nowMs).toISOString(),
      });
    }
    return views;
  }
}
