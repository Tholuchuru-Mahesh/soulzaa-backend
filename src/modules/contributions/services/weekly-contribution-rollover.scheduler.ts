import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { currentIsoWeekKeyUtc, isoWeekWindowUtc } from 'src/common/utils/iso-week.util';
import { ContributionCounterUpdatedEvent } from 'src/modules/treasure-boxes/events/treasure.events';
import { WeeklyContributionRepository } from '../repositories/weekly-contribution.repository';

const ROLLOVER_LOCK_KEY = 'contributions:weekly-rollover';

/**
 * At Monday 00:00:00 UTC every LIVE room is pushed the new ISO week's
 * contribution figure (0, or whatever a gift in the first second already added)
 * over the SAME socket event gifts use — so open rooms visibly reset with no
 * gift, rejoin or refresh. The per-week bucket model means there is nothing to
 * actually "reset": the write path just starts addressing the new week's row.
 * This job is purely the live-client nudge.
 */
@Injectable()
export class WeeklyContributionRolloverScheduler {
  private readonly logger = new Logger(WeeklyContributionRolloverScheduler.name);

  constructor(
    private readonly repo: WeeklyContributionRepository,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  @Cron('0 0 * * 1', { name: 'weekly-contribution-rollover', timeZone: 'UTC' })
  async broadcastRollover(): Promise<void> {
    await this.locks
      .withLock(ROLLOVER_LOCK_KEY, () => this.run(), { ttlMs: 55_000, retries: 0 })
      .catch((err) => this.logger.warn(`Weekly rollover skipped: ${(err as Error).message}`));
  }

  /** Exposed for tests / an admin "re-broadcast now" action. */
  async run(): Promise<{ weekKey: string; rooms: number }> {
    const weekKey = currentIsoWeekKeyUtc();
    const { start, end } = isoWeekWindowUtc(weekKey);
    const roomIds = await this.repo.liveRoomIds();

    for (const roomId of roomIds) {
      const [week, lifetime] = await Promise.all([
        this.repo.getWeekBucket('room', roomId, weekKey),
        this.repo.roomLifetimeContribution(roomId),
      ]);
      await this.bus.publish(
        new ContributionCounterUpdatedEvent({
          roomId,
          receiverId: null,
          roomTotal: lifetime,
          receiverTotal: null,
          roomWeekTotal: week.amount,
          receiverWeekTotal: null,
          weekKey,
          reason: 'week_rollover',
        }),
      );
    }

    this.logger.log(
      `Weekly contribution rollover → ${weekKey} (${start.toISOString()}..${end.toISOString()}), ${roomIds.length} live room(s) notified`,
    );
    return { weekKey, rooms: roomIds.length };
  }
}
