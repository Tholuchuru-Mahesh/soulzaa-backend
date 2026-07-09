import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CreatorDailyStat, RoomActivity, RoomDailyStat, RoomMemberRole } from '@prisma/client';
import type { PlatformRole } from 'src/common/constants';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
} from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import {
  ANALYTICS_ADMIN_ROLES,
  ANALYTICS_ROOM_MANAGER_ROLES,
  dateKeyDaysAgo,
  dateKeyOf,
} from '../constants/analytics.constants';
import type {
  CreatorAnalyticsView,
  CreatorDailyStatView,
  RoomDailyStatView,
  RoomReportView,
} from '../dto/analytics.dto';
import { AnalyticsRepository } from '../repositories/analytics.repository';
import { GLOBAL_ANALYTICS_UUID } from './analytics.service';
import { AnalyticsCountersService } from './analytics-counters.service';
import { AnalyticsRollupService } from './analytics-rollup.service';

/** Minimal actor identity a controller passes in. */
export interface AnalyticsActor {
  id: string;
  roles: PlatformRole[];
}

/**
 * AR-13 read surfaces: a gated room-owner report and a creator's self-analytics.
 * Both combine durable daily rollups (history) with the live Redis counters
 * (today). Room reports require room-manager or platform-admin authority.
 */
@Injectable()
export class AnalyticsReportingService {
  constructor(
    private readonly repo: AnalyticsRepository,
    private readonly counters: AnalyticsCountersService,
    private readonly rollup: AnalyticsRollupService,
    @Inject(AUDIO_ROOMS_SERVICE) private readonly rooms: IAudioRoomsService,
  ) {}

  /** Owner/admin-only room analytics: cumulative + today + revenue + daily series. */
  async getRoomReport(
    actor: AnalyticsActor,
    roomId: string,
    days: number,
  ): Promise<RoomReportView> {
    await this.assertRoomManager(actor, roomId);

    const dateKey = dateKeyOf();
    const [activity, live, series, revenue] = await Promise.all([
      this.repo.findRoomActivity(roomId),
      this.counters.readRoom(roomId, dateKey),
      this.repo.listRoomDailyStats(roomId, dateKeyDaysAgo(days)),
      this.repo.getRevenueReports({ roomId, userId: GLOBAL_ANALYTICS_UUID }),
    ]);

    let giftCoins = 0n;
    let creatorCoins = 0n;
    for (const r of revenue) {
      giftCoins += r.giftCoins;
      creatorCoins += r.creatorCoins;
    }

    return {
      roomId,
      activity: activity ? this.roomActivityView(activity) : null,
      today: {
        dateKey,
        joins: live.joins,
        uniqueVisitors: live.uniqueVisitors,
        peakParticipants: live.peakParticipants,
        messages: live.messages,
        giftCount: live.giftCount,
        giftCoins: live.giftCoins,
        speakingSeconds: live.speakingSeconds,
        engagementScore: this.rollup.roomEngagement(live),
      },
      revenue: { giftCoins: giftCoins.toString(), creatorCoins: creatorCoins.toString() },
      dailySeries: series.map((s) => this.roomDailyView(s)),
    };
  }

  /** A user's own creator analytics: today + lifetime totals + revenue + series. */
  async getMyAnalytics(userId: string, days: number): Promise<CreatorAnalyticsView> {
    const dateKey = dateKeyOf();
    const [live, totals, series, revenue] = await Promise.all([
      this.counters.readCreator(userId, dateKey),
      this.repo.sumCreatorDailyStats(userId),
      this.repo.listCreatorDailyStats(userId, dateKeyDaysAgo(days)),
      this.repo.getRevenueReports({ userId, roomId: GLOBAL_ANALYTICS_UUID }),
    ]);

    let giftCoins = 0n;
    let creatorCoins = 0n;
    for (const r of revenue) {
      giftCoins += r.giftCoins;
      creatorCoins += r.creatorCoins;
    }

    return {
      userId,
      today: {
        dateKey,
        giftsReceivedCount: live.giftsReceivedCount,
        giftCoinsReceived: live.giftCoinsReceived,
        creatorEarnings: live.creatorEarnings,
        roomsHosted: live.roomsHosted,
        speakingSeconds: live.speakingSeconds,
        engagementScore: this.rollup.creatorEngagement(live),
      },
      totals: {
        giftsReceivedCount: totals.giftsReceivedCount,
        giftCoinsReceived: totals.giftCoinsReceived.toString(),
        creatorEarnings: totals.creatorEarnings.toString(),
        roomsHosted: totals.roomsHosted,
        speakingSeconds: totals.speakingSeconds.toString(),
        audioHours: Math.round((Number(totals.speakingSeconds) / 3600) * 100) / 100,
      },
      revenue: { giftCoins: giftCoins.toString(), creatorCoins: creatorCoins.toString() },
      dailySeries: series.map((s) => this.creatorDailyView(s)),
    };
  }

  /** Owner + room managers + platform admins may read a room's analytics. */
  async assertRoomManager(actor: AnalyticsActor, roomId: string): Promise<void> {
    if (actor.roles.some((r) => (ANALYTICS_ADMIN_ROLES as readonly string[]).includes(r))) return;
    const role = await this.rooms.getEffectiveRole(roomId, actor.id);
    if (role && ANALYTICS_ROOM_MANAGER_ROLES.includes(role as RoomMemberRole)) return;
    throw new BusinessException(
      ERROR_CODES.ANALYTICS_NOT_AUTHORIZED,
      'Only the room owner or an admin can view this room’s analytics.',
      HttpStatus.FORBIDDEN,
    );
  }

  // ---- views ----

  private roomActivityView(a: RoomActivity) {
    return {
      roomId: a.roomId,
      peakParticipants: a.peakParticipants,
      totalJoined: a.totalJoined,
      totalGifts: a.totalGifts,
      totalGiftCoins: a.totalGiftCoins.toString(),
      totalSpeakingMinutes: a.totalSpeakingMinutes,
      durationSeconds: a.durationSeconds,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  private roomDailyView(s: RoomDailyStat): RoomDailyStatView {
    return {
      dateKey: s.dateKey,
      joins: s.joins,
      uniqueVisitors: s.uniqueVisitors,
      peakParticipants: s.peakParticipants,
      messages: s.messages,
      giftCount: s.giftCount,
      giftCoins: s.giftCoins.toString(),
      speakingSeconds: s.speakingSeconds.toString(),
      engagementScore: s.engagementScore,
    };
  }

  private creatorDailyView(s: CreatorDailyStat): CreatorDailyStatView {
    return {
      dateKey: s.dateKey,
      giftsReceivedCount: s.giftsReceivedCount,
      giftCoinsReceived: s.giftCoinsReceived.toString(),
      creatorEarnings: s.creatorEarnings.toString(),
      roomsHosted: s.roomsHosted,
      speakingSeconds: s.speakingSeconds.toString(),
      engagementScore: s.engagementScore,
    };
  }
}
