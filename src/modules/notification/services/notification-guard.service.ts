import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from 'src/infra/redis/redis.service';
import type { PushCategory } from 'src/modules/device/interfaces/push.constants';
import { GUARD_BUDGET } from '../constants/notification-guard.constants';

const DEDUPE_PREFIX = 'notif:guard:';
const BUDGET_PREFIX = 'notif:budget:';

/**
 * Duplicate-suppression and per-user rate limiting for notification producers.
 *
 * Deliberately **opt-in at the call site** rather than baked into
 * `NotificationService.create()`. Two gifts in a row are two real events, and a
 * `create()` that silently no-opped would be a bug wearing a feature's clothes.
 * A producer that knows its natural idempotency key — a transaction id, a game
 * session, a device — opts in; one that has no such key does not pretend to.
 *
 * Every method **fails open**. If Redis is unreachable we would rather send a
 * duplicate notification than drop a real one: a user seeing "recharge
 * successful" twice is an annoyance, a user never seeing it is a support ticket
 * about missing money. The same reasoning the notification module already
 * applies to a failed preference read.
 */
@Injectable()
export class NotificationGuard {
  private readonly logger = new Logger(NotificationGuard.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Run `fn` at most once per `key` per `ttlSeconds`.
   *
   * @returns `fn`'s value on the first call, or `null` when suppressed — so a
   * caller that needs to know whether it won the race can compare against null.
   * An error thrown by `fn` itself propagates: the claim is about duplicate
   * *delivery*, not about swallowing failures.
   */
  async once<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null> {
    let claimed = true;

    try {
      const result = await this.redis.client.set(
        `${DEDUPE_PREFIX}${key}`,
        '1',
        'EX',
        ttlSeconds,
        'NX',
      );
      claimed = result === 'OK';
    } catch (err) {
      this.logger.warn(`dedupe check failed for "${key}", proceeding: ${(err as Error).message}`);
    }

    if (!claimed) return null;
    return fn();
  }

  /**
   * Whether this user may receive another notification in this category during
   * the current window. A backstop against a runaway producer, not a curation
   * policy — see GUARD_BUDGET.
   */
  async withinBudget(userId: string, category: PushCategory): Promise<boolean> {
    const key = `${BUDGET_PREFIX}${userId}:${category}`;

    try {
      const count = await this.redis.client.incr(key);

      // Only on the first increment: re-setting the TTL every time would slide
      // the window forward indefinitely, so a steady trickle would never reset.
      if (count === 1) await this.redis.client.expire(key, GUARD_BUDGET.WINDOW_SECONDS);

      if (count > GUARD_BUDGET.PER_CATEGORY_PER_HOUR) {
        this.logger.warn(`rate limit hit: user=${userId} category=${category} count=${count}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`budget check failed for ${userId}, permitting: ${(err as Error).message}`);
      return true;
    }
  }
}
