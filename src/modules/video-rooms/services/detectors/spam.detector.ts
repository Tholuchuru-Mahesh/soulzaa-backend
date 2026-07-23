import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { spamCounterKey } from '../../constants/video-room-moderation.constants';
import type {
  DetectionResult,
  ModerationDetector,
  ModerationDetectorConfig,
  ModerationSignal,
} from './moderation-detector.interface';

/**
 * Spam detector. Reconciles with the chat layer's own spam detection rather
 * than re-scanning message text: it counts each message the chat pipeline
 * ALREADY flagged (`spamFlagged`) exactly once, and ignores unflagged messages
 * entirely. Once a user accrues `spamThreshold` flagged messages inside the
 * rolling `spamWindowSec`, it recommends an auto-mute.
 */
@Injectable()
export class SpamDetector implements ModerationDetector {
  readonly kind = 'spam';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async evaluate(
    signal: ModerationSignal,
    cfg: ModerationDetectorConfig,
  ): Promise<DetectionResult | null> {
    if (signal.type !== 'message') return null;
    // Reconciliation seam: the chat layer already scanned this message. Count
    // its verdict once here; never re-scan the text.
    if (!signal.spamFlagged) return null;

    const count = await this.incrementWindow(
      spamCounterKey(signal.roomId, signal.userId),
      cfg.spamWindowSec,
    );
    if (count < cfg.spamThreshold) return null;

    return {
      action: 'auto_mute',
      reason: `Automated spam detection: ${count} flagged message(s) within ${cfg.spamWindowSec}s.`,
    };
  }

  /** `INCR` the counter, arming its TTL only on the first write of the window. */
  private async incrementWindow(key: string, windowSec: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSec);
    return count;
  }
}
