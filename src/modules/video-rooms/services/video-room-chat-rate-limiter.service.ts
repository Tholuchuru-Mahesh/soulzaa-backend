import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import {
  videoRoomChatCooldownKey,
  videoRoomChatDedupKey,
  videoRoomChatFloodKey,
  videoRoomChatRateKey,
  videoRoomChatSlowKey,
  videoRoomChatViolationKey,
} from '../constants/video-room-chat.constants';
import { ChatSpamDetectedEvent, type ChatSpamKind } from '../events/video-room-chat.events';

export interface RateLimitOptions {
  rateMax: number;
  slowModeSeconds: number;
}

/**
 * VR-9 anti-abuse. Five Redis gates evaluated in a deliberate order —
 * cooldown → rate → slow mode → flood → duplicate — so the cheapest, most
 * decisive rejection happens first and a user already serving a cooldown never
 * burns further counters.
 *
 * Deliberately stops at a cooldown. AR-4's equivalent escalates to auto-mute and
 * auto-kick, but "Moderation Actions" is out of scope for VR-9: same detection,
 * no enforcement this phase is not scoped for.
 */
@Injectable()
export class VideoRoomChatRateLimiter {
  private readonly logger = new Logger(VideoRoomChatRateLimiter.name);

  constructor(
    private readonly cache: CacheService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly config: ConfigService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async assertMaySend(
    roomId: string,
    userId: string,
    content: string,
    opts: RateLimitOptions,
  ): Promise<void> {
    const cfg = loadVideoRoomChatConfig(this.config);

    // 1. Serving a cooldown? Nothing else matters.
    if (await this.cache.exists(videoRoomChatCooldownKey(roomId, userId))) {
      this.spam(roomId, userId, 'cooldown');
      throw this.tooFast('You are temporarily cooled down — please wait before sending again.');
    }

    // 2. Rolling per-minute cap.
    const rate = await this.cache.increment(videoRoomChatRateKey(roomId, userId), {
      ttlSeconds: cfg.rateWindowSeconds,
    });
    if (rate > opts.rateMax) {
      this.spam(roomId, userId, 'rate');
      throw this.tooFast('You are sending messages too quickly.');
    }

    // 3. Room slow mode. NO spam signal — see `ChatSpamKind`.
    if (
      opts.slowModeSeconds > 0 &&
      (await this.cache.exists(videoRoomChatSlowKey(roomId, userId)))
    ) {
      throw new BusinessException(
        ERROR_CODES.CHAT_SLOW_MODE,
        'Slow mode is enabled — please wait before sending again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 4. Burst detection → arm the escalating cooldown.
    const burst = await this.cache.increment(videoRoomChatFloodKey(roomId, userId), {
      ttlSeconds: cfg.floodBurstWindowSeconds,
    });
    if (burst > cfg.floodBurstMax) {
      await this.armCooldown(roomId, userId, cfg.cooldownSteps);
      this.spam(roomId, userId, 'flood');
      throw this.tooFast('Too many messages at once — slow down.');
    }

    // 5. Duplicate suppression (atomic SET NX).
    const hash = createHash('sha1').update(content.toLowerCase()).digest('hex');
    const claimed = await this.redis.set(
      videoRoomChatDedupKey(roomId, userId, hash),
      '1',
      'EX',
      cfg.dedupWindowSeconds,
      'NX',
    );
    if (claimed === null) {
      this.spam(roomId, userId, 'duplicate');
      throw new BusinessException(
        ERROR_CODES.DUPLICATE_MESSAGE,
        'Duplicate message ignored.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Start this sender's slow-mode window after a successful send. */
  async applySlowMode(roomId: string, userId: string, seconds: number): Promise<void> {
    if (seconds <= 0) return;
    await this.redis.set(videoRoomChatSlowKey(roomId, userId), '1', 'EX', seconds);
  }

  /**
   * Escalate through the cooldown ladder. The rolling violation counter picks the
   * rung; repeat offenders wait longer, and the ladder saturates at its last rung
   * rather than running off the end of the array.
   */
  private async armCooldown(roomId: string, userId: string, steps: number[]): Promise<void> {
    if (steps.length === 0) return;
    const violations = await this.cache.increment(videoRoomChatViolationKey(roomId, userId), {
      ttlSeconds: 3600,
    });
    const seconds = steps[Math.min(violations, steps.length) - 1];
    await this.redis.set(videoRoomChatCooldownKey(roomId, userId), '1', 'EX', seconds);
  }

  private tooFast(message: string): BusinessException {
    return new BusinessException(
      ERROR_CODES.CHAT_RATE_LIMITED,
      message,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * `tooFast` is a factory that RETURNS an exception rather than throwing, so
   * publication cannot be folded into it — each gate publishes, then throws.
   */
  private spam(roomId: string, userId: string, kind: ChatSpamKind): void {
    // Fire-and-forget: this is the anti-abuse rejection path, so it must not
    // depend on the health of SPAM_DETECTED listeners. `emitAsync` propagates a
    // subscriber's thrown error (or an unbounded hang) right out of `publish`,
    // which would replace the intended rate-limit/duplicate exception with a
    // 500 — or block the rejection entirely. Publish, swallow and log any
    // listener failure, then let the caller throw regardless.
    void this.bus
      .publish(new ChatSpamDetectedEvent({ roomId, userId, kind }))
      .catch((error: Error) =>
        this.logger.warn(`Spam signal publish failed for kind=${kind}: ${error.message}`),
      );
  }
}
