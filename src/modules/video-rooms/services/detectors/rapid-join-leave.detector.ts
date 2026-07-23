import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { joinLeaveKey } from '../../constants/video-room-moderation.constants';
import type {
  DetectionResult,
  ModerationDetector,
  ModerationDetectorConfig,
  ModerationSignal,
} from './moderation-detector.interface';

/**
 * Rapid join/leave detector. Counts every membership transition (a join OR a
 * leave — the signal doesn't distinguish, so the threshold is expressed in raw
 * transitions) on a rolling `rapidJoinLeaveWindowSec` counter; crossing
 * `rapidJoinLeaveThreshold` recommends an auto-kick, since churn at that rate is
 * the classic "join-flood / raid" abuse pattern.
 */
@Injectable()
export class RapidJoinLeaveDetector implements ModerationDetector {
  readonly kind = 'rapid-join-leave';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async evaluate(
    signal: ModerationSignal,
    cfg: ModerationDetectorConfig,
  ): Promise<DetectionResult | null> {
    if (signal.type !== 'join_leave') return null;

    const count = await this.incrementWindow(
      joinLeaveKey(signal.roomId, signal.userId),
      cfg.rapidJoinLeaveWindowSec,
    );
    if (count < cfg.rapidJoinLeaveThreshold) return null;

    return {
      action: 'auto_kick',
      reason: `Automated rapid join/leave detection: ${count} transition(s) within ${cfg.rapidJoinLeaveWindowSec}s.`,
    };
  }

  /** `INCR` the counter, arming its TTL only on the first write of the window. */
  private async incrementWindow(key: string, windowSec: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSec);
    return count;
  }
}
