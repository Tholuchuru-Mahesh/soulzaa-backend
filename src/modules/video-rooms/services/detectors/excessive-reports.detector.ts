import { Inject, Injectable } from '@nestjs/common';
import { VideoRoomReportReason } from '@prisma/client';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { reportCounterKey } from '../../constants/video-room-moderation.constants';
import type {
  DetectionResult,
  ModerationDetector,
  ModerationDetectorConfig,
  ModerationSignal,
} from './moderation-detector.interface';

/**
 * Excessive-reports detector. Counts reports RECEIVED against a target user on
 * a rolling `excessiveReportsWindowSec` counter; crossing
 * `excessiveReportsThreshold` recommends an auto-flag (not a punitive mute/kick)
 * so a human moderator triages — many independent reporters is a strong abuse
 * signal but still warrants review rather than automatic enforcement. Emits the
 * `ABUSE` report reason so the system report opens in the right category.
 */
@Injectable()
export class ExcessiveReportsDetector implements ModerationDetector {
  readonly kind = 'excessive-reports';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async evaluate(
    signal: ModerationSignal,
    cfg: ModerationDetectorConfig,
  ): Promise<DetectionResult | null> {
    if (signal.type !== 'report') return null;

    const count = await this.incrementWindow(
      reportCounterKey(signal.roomId, signal.targetUserId),
      cfg.excessiveReportsWindowSec,
    );
    if (count < cfg.excessiveReportsThreshold) return null;

    return {
      action: 'auto_flag',
      reason: `Automated excessive-reports detection: ${count} report(s) against the target within ${cfg.excessiveReportsWindowSec}s.`,
      meta: { reportReason: VideoRoomReportReason.ABUSE },
    };
  }

  /** `INCR` the counter, arming its TTL only on the first write of the window. */
  private async incrementWindow(key: string, windowSec: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSec);
    return count;
  }
}
