import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { VipExpiredEvent, VipExpiringEvent } from '../events/vip.events';

/** How far ahead of expiry the user is warned. */
export const VIP_EXPIRY_WARNING_DAYS = 3;

const DAY_MS = 86_400_000;

export interface VipSweepResult {
  expiring: number;
  expired: number;
}

/**
 * Finds memberships that are about to lapse, or already have, and announces it.
 *
 * This exists because **nothing happens when time passes**. Every other VIP
 * event is the echo of a user action — a purchase, a renewal, an upgrade — and
 * can be published from the request that caused it. Expiry is the one state
 * change with no request behind it, so without a scheduled sweep
 * `VIP_EXPIRING` and `VIP_EXPIRED` could never fire at all.
 *
 * The sweep is deliberately idempotent in two different ways, because it runs
 * daily over a multi-day window:
 *  - `EXPIRED` flips `status` to `'EXPIRED'`, so a lapsed membership is only
 *    ever found once.
 *  - `EXPIRING` cannot use a status flag (the membership is still active), so
 *    suppression is the notification listener's job — it dedupes on the expiry
 *    date, not on "today".
 */
@Injectable()
export class VipExpiryService {
  private readonly logger = new Logger(VipExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async sweep(now: Date = new Date()): Promise<VipSweepResult> {
    const expired = await this.sweepExpired(now);
    const expiring = await this.sweepExpiring(now);

    if (expired > 0 || expiring > 0) {
      this.logger.log(`VIP sweep: ${expiring} expiring, ${expired} expired`);
    }
    return { expiring, expired };
  }

  /**
   * Memberships still marked ACTIVE whose expiry has passed. Flipping the status
   * is what makes this run-once: the next sweep will not see them again.
   */
  private async sweepExpired(now: Date): Promise<number> {
    const lapsed = await this.prisma.vipMembership.findMany({
      where: { status: 'ACTIVE', expiresAt: { lte: now } },
      select: { id: true, userId: true, level: true },
    });
    if (lapsed.length === 0) return 0;

    await this.prisma.vipMembership.updateMany({
      where: { id: { in: lapsed.map((m) => m.id) } },
      data: { status: 'EXPIRED' },
    });

    // Published after the status write commits, so a consumer that reads back
    // the membership sees EXPIRED rather than racing the update.
    for (const m of lapsed) {
      await this.bus.publish(new VipExpiredEvent({ userId: m.userId, level: m.level }));
    }
    return lapsed.length;
  }

  /** Still active, but inside the warning window. */
  private async sweepExpiring(now: Date): Promise<number> {
    const horizon = new Date(now.getTime() + VIP_EXPIRY_WARNING_DAYS * DAY_MS);

    const soon = await this.prisma.vipMembership.findMany({
      where: { status: 'ACTIVE', expiresAt: { gt: now, lte: horizon } },
      select: { userId: true, level: true, expiresAt: true },
    });

    for (const m of soon) {
      // Rounded up: something expiring in 25 hours is "2 days", never "1".
      const daysRemaining = Math.max(
        1,
        Math.ceil((m.expiresAt.getTime() - now.getTime()) / DAY_MS),
      );

      await this.bus.publish(
        new VipExpiringEvent({
          userId: m.userId,
          level: m.level,
          expiresAt: m.expiresAt,
          daysRemaining,
        }),
      );
    }
    return soon.length;
  }
}
