import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { dupKey } from '../../constants/video-room-moderation.constants';
import type {
  DetectionResult,
  ModerationDetector,
  ModerationDetectorConfig,
  ModerationSignal,
} from './moderation-detector.interface';

/**
 * Duplicate-message detector. Keeps the user's last content hash in Redis under
 * a `duplicateWindowSec` TTL and, on each message, compares the incoming hash
 * against it: an identical hash still present in the window is a repeat and
 * recommends an auto-mute. Uses the chat-supplied `contentHash` — it never
 * re-hashes or re-scans the text. Detects consecutive duplicates (the
 * "last-content-hash" marker the Task-2 `dupKey` doc describes), which is the
 * dominant copy-paste-spam pattern.
 *
 * `contentHash` is optional on the signal precisely because not every
 * `message` source can supply a real one (e.g. the chat `SPAM_DETECTED`
 * reconciliation signal carries no message text). This detector treats an
 * absent `contentHash` as "not applicable" and skips entirely — it must never
 * be fed a low-cardinality proxy (like a spam-kind enum), which would collapse
 * unrelated rejections onto the same "hash" and false-positive as a repeat.
 */
@Injectable()
export class DuplicateDetector implements ModerationDetector {
  readonly kind = 'duplicate';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async evaluate(
    signal: ModerationSignal,
    cfg: ModerationDetectorConfig,
  ): Promise<DetectionResult | null> {
    if (signal.type !== 'message' || !signal.contentHash) return null;

    const key = dupKey(signal.roomId, signal.userId);
    const previous = await this.redis.get(key);
    // Refresh the marker (and slide its window) to the current hash.
    await this.redis.set(key, signal.contentHash, 'PX', cfg.duplicateWindowSec * 1000);

    if (previous === null || previous !== signal.contentHash) return null;

    return {
      action: 'auto_mute',
      reason: `Automated duplicate-message detection: identical content repeated within ${cfg.duplicateWindowSec}s.`,
    };
  }
}
