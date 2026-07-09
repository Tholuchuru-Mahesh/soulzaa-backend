import { Injectable, Logger } from '@nestjs/common';
import { ENGAGEMENT_WEIGHTS, dateKeyDaysAgo, dateKeyOf } from '../constants/analytics.constants';
import { AnalyticsRepository } from '../repositories/analytics.repository';
import {
  AnalyticsCountersService,
  type CreatorCounters,
  type RoomCounters,
} from './analytics-counters.service';

/**
 * Materializes the live Redis counters into durable daily-stat rollup tables and
 * ingests queue-only source events (chat messages) into the counters. Invoked by
 * the ANALYTICS_PROCESSING worker: `analytics.rollup` runs the nightly rollup;
 * `chat.message` records a room message.
 */
@Injectable()
export class AnalyticsRollupService {
  private readonly logger = new Logger(AnalyticsRollupService.name);

  constructor(
    private readonly repo: AnalyticsRepository,
    private readonly counters: AnalyticsCountersService,
  ) {}

  /** Record a chat message toward the room's live engagement counters. */
  async recordChatMessage(roomId: string): Promise<void> {
    await this.counters.incrRoom(roomId, dateKeyOf(), 'messages', 1);
  }

  /**
   * Roll up a day's counters into the daily-stat tables. Defaults to yesterday
   * (a completed day). Idempotent — re-running overwrites with the same snapshot.
   */
  async runDailyRollup(dateKey: string = dateKeyDaysAgo(1)): Promise<{
    rooms: number;
    creators: number;
  }> {
    const roomIds = await this.counters.listActiveRooms(dateKey);
    for (const roomId of roomIds) {
      try {
        const c = await this.counters.readRoom(roomId, dateKey);
        await this.repo.upsertRoomDailyStat({
          dateKey,
          roomId,
          joins: c.joins,
          uniqueVisitors: c.uniqueVisitors,
          peakParticipants: c.peakParticipants,
          messages: c.messages,
          giftCount: c.giftCount,
          giftCoins: BigInt(c.giftCoins),
          speakingSeconds: BigInt(c.speakingSeconds),
          engagementScore: this.roomEngagement(c),
        });
      } catch (err) {
        this.logger.error(
          `Room rollup failed for ${roomId} (${dateKey}): ${(err as Error).message}`,
        );
      }
    }

    const creatorIds = await this.counters.listActiveCreators(dateKey);
    for (const userId of creatorIds) {
      try {
        const c = await this.counters.readCreator(userId, dateKey);
        await this.repo.upsertCreatorDailyStat({
          dateKey,
          userId,
          giftsReceivedCount: c.giftsReceivedCount,
          giftCoinsReceived: BigInt(c.giftCoinsReceived),
          creatorEarnings: BigInt(c.creatorEarnings),
          roomsHosted: c.roomsHosted,
          speakingSeconds: BigInt(c.speakingSeconds),
          engagementScore: this.creatorEngagement(c),
        });
      } catch (err) {
        this.logger.error(
          `Creator rollup failed for ${userId} (${dateKey}): ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Analytics rollup ${dateKey}: ${roomIds.length} room(s), ${creatorIds.length} creator(s).`,
    );
    return { rooms: roomIds.length, creators: creatorIds.length };
  }

  roomEngagement(c: RoomCounters): number {
    return Math.round(
      c.joins * ENGAGEMENT_WEIGHTS.join +
        c.messages * ENGAGEMENT_WEIGHTS.message +
        c.giftCount * ENGAGEMENT_WEIGHTS.gift +
        (c.speakingSeconds / 60) * ENGAGEMENT_WEIGHTS.speakingMinute,
    );
  }

  creatorEngagement(c: CreatorCounters): number {
    return Math.round(
      c.roomsHosted * ENGAGEMENT_WEIGHTS.join +
        c.giftsReceivedCount * ENGAGEMENT_WEIGHTS.gift +
        (c.speakingSeconds / 60) * ENGAGEMENT_WEIGHTS.speakingMinute,
    );
  }
}
