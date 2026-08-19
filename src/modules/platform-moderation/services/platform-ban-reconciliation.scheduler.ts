import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { PlatformBanRepository } from '../repositories/platform-ban.repository';
import { banRedisKey } from './platform-ban.service';

/**
 * Ban enforcement (`PlatformBanService.assertNotGloballyBanned`) is a
 * Redis-only check on the hottest path in the app — every room create/join,
 * for every user — by design; adding a Postgres round-trip there would cost
 * every user on every request just to catch the rare banned one. But that
 * makes Redis the enforcement mechanism, not merely a cache of it: any
 * transient loss of a ban's key (a Redis restart, an eviction under memory
 * pressure, an ops `FLUSHDB`) silently stops enforcing an otherwise still-
 * ACTIVE, unexpired ban — no error, no self-healing, the row in
 * `PlatformUserBan` just stops meaning anything until someone re-bans.
 *
 * Re-priming every currently-active ban's key on a short interval, off the
 * request path entirely, bounds that gap to well under a minute instead of
 * indefinitely.
 */
@Injectable()
export class PlatformBanReconciliationScheduler {
  private readonly logger = new Logger(PlatformBanReconciliationScheduler.name);

  constructor(
    private readonly repo: PlatformBanRepository,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async reconcile(): Promise<void> {
    let activeBans;
    try {
      activeBans = await this.repo.listActive();
    } catch (e) {
      this.logger.error(`Failed to load active platform bans for reconciliation: ${(e as Error).message}`);
      return;
    }

    for (const ban of activeBans) {
      const remainingSeconds = Math.floor((ban.expiresAt.getTime() - Date.now()) / 1000);
      if (remainingSeconds <= 0) continue;
      try {
        await this.redis.set(
          banRedisKey(ban.targetUserId),
          JSON.stringify({ reason: ban.reason, expiresAt: ban.expiresAt.toISOString() }),
          'EX',
          remainingSeconds,
        );
      } catch (e) {
        this.logger.error(
          `Failed to re-prime ban cache for user ${ban.targetUserId}: ${(e as Error).message}`,
        );
      }
    }
  }
}
