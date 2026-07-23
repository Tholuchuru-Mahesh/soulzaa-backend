import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { floodCounterKey } from '../../constants/video-room-moderation.constants';
import type {
  DetectionResult,
  ModerationDetector,
  ModerationDetectorConfig,
  ModerationSignal,
} from './moderation-detector.interface';

/**
 * Flood detector. Pure message-volume rule — counts EVERY message from a user
 * (spam-flagged or not) in a short rolling `floodWindowSec`; crossing
 * `floodThreshold` recommends an auto-mute. Complements the spam detector,
 * which only counts already-flagged content: flood catches high-rate but
 * individually-clean message bursts.
 */
@Injectable()
export class FloodDetector implements ModerationDetector {
  readonly kind = 'flood';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async evaluate(
    signal: ModerationSignal,
    cfg: ModerationDetectorConfig,
  ): Promise<DetectionResult | null> {
    if (signal.type !== 'message') return null;

    const count = await this.incrementWindow(
      floodCounterKey(signal.roomId, signal.userId),
      cfg.floodWindowSec,
    );
    if (count < cfg.floodThreshold) return null;

    return {
      action: 'auto_mute',
      reason: `Automated flood detection: ${count} message(s) within ${cfg.floodWindowSec}s.`,
    };
  }

  /** `INCR` the counter, arming its TTL only on the first write of the window. */
  private async incrementWindow(key: string, windowSec: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSec);
    return count;
  }
}
