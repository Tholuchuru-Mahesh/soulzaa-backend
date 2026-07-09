import { Injectable, HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  QueryRevenueDto,
  RevenueReportView,
  RoomActivityView,
  RoomAttendanceView,
  RoomEngagementView,
  RoomSpeakingView,
} from '../dto/analytics.dto';
import type { IAnalyticsService } from '../interfaces/analytics.service.interface';
import { AnalyticsRepository } from '../repositories/analytics.repository';

// Constant for all-zero global reference UUID
export const GLOBAL_ANALYTICS_UUID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class AnalyticsService implements IAnalyticsService {
  constructor(private readonly repo: AnalyticsRepository) {}

  // ---- IAnalyticsService ----

  async getRoomActivity(roomId: string): Promise<RoomActivityView> {
    const activity = await this.repo.findRoomActivity(roomId);
    if (!activity) {
      throw new BusinessException(
        ERROR_CODES.NOT_FOUND,
        'No activity records found for this room.',
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      roomId: activity.roomId,
      peakParticipants: activity.peakParticipants,
      totalJoined: activity.totalJoined,
      totalGifts: activity.totalGifts,
      totalGiftCoins: activity.totalGiftCoins.toString(),
      totalSpeakingMinutes: activity.totalSpeakingMinutes,
      durationSeconds: activity.durationSeconds,
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt,
    };
  }

  async getSpeakingDurations(
    roomId: string,
    skip: number,
    limit: number,
    page: number,
  ): Promise<Paginated<RoomSpeakingView>> {
    const [groups, total] = await this.repo.getSpeakingDurationsGrouped(roomId, skip, limit);

    if (groups.length === 0) {
      return buildPaginated([], total, page, limit);
    }

    const userIds = groups.map((g) => g.userId);
    const details = await this.repo.getUsersDetails(userIds);
    const profiles = await this.repo.getUserProfiles(userIds);

    const items: RoomSpeakingView[] = groups.map((g) => {
      const detail = details.find((d) => d.id === g.userId);
      const profile = profiles.find((p) => p.userId === g.userId);

      return {
        userId: g.userId,
        username: detail?.username ?? 'Unknown',
        avatarKey: profile?.avatarKey ?? null,
        speakingSeconds: g._sum.speakingSeconds ?? 0,
      };
    });

    return buildPaginated(items, total, page, limit);
  }

  async getAttendance(
    roomId: string,
    skip: number,
    limit: number,
    page: number,
  ): Promise<Paginated<RoomAttendanceView>> {
    const [visitors, total] = await this.repo.listVisitors(roomId, skip, limit);

    if (visitors.length === 0) {
      return buildPaginated([], total, page, limit);
    }

    const userIds = visitors.map((v) => v.userId);
    const details = await this.repo.getUsersDetails(userIds);
    const profiles = await this.repo.getUserProfiles(userIds);

    const items: RoomAttendanceView[] = visitors.map((v) => {
      const detail = details.find((d) => d.id === v.userId);
      const profile = profiles.find((p) => p.userId === v.userId);

      return {
        userId: v.userId,
        username: detail?.username ?? 'Unknown',
        avatarKey: profile?.avatarKey ?? null,
        joinedAt: v.joinedAt,
        leftAt: v.leftAt,
        durationSeconds: v.durationSeconds,
      };
    });

    return buildPaginated(items, total, page, limit);
  }

  async getEngagement(roomId: string): Promise<RoomEngagementView> {
    const activity = await this.repo.findRoomActivity(roomId);
    if (!activity) {
      throw new BusinessException(
        ERROR_CODES.NOT_FOUND,
        'No activity records found for this room.',
        HttpStatus.NOT_FOUND,
      );
    }

    // 1. Calculate average stay duration
    const [visitors] = await this.repo.listVisitors(roomId, 0, 100000); // pull stats
    const finishedVisitors = visitors.filter((v) => v.leftAt !== null);
    const averageStayDurationSeconds =
      finishedVisitors.length > 0
        ? Math.round(
            finishedVisitors.reduce((sum, v) => sum + v.durationSeconds, 0) /
              finishedVisitors.length,
          )
        : 0;

    // 2. Speaking to viewer ratio
    const [, totalSpeakers] = await this.repo.getSpeakingDurationsGrouped(roomId, 0, 100000);
    const totalVisitors = activity.totalJoined;
    const speakingToViewerRatio =
      totalVisitors > 0 ? Math.round((totalSpeakers / totalVisitors) * 10000) / 100 : 0;

    // 3. Gift intensities
    const giftIntensity =
      totalVisitors > 0 ? Math.round((activity.totalGifts / totalVisitors) * 100) / 100 : 0;
    const coinIntensity =
      totalVisitors > 0
        ? Math.round((Number(activity.totalGiftCoins) / totalVisitors) * 100) / 100
        : 0;

    return {
      roomId,
      averageStayDurationSeconds,
      speakingToViewerRatio,
      giftIntensity,
      coinIntensity,
    };
  }

  async getRevenue(query: QueryRevenueDto): Promise<RevenueReportView[]> {
    const reports = await this.repo.getRevenueReports({
      startDate: query.startDate,
      endDate: query.endDate,
      roomId: query.roomId ?? GLOBAL_ANALYTICS_UUID,
      userId: query.userId ?? GLOBAL_ANALYTICS_UUID,
    });

    return reports.map((r) => ({
      dateKey: r.dateKey,
      roomId: r.roomId,
      userId: r.userId,
      giftCoins: r.giftCoins.toString(),
      creatorCoins: r.creatorCoins.toString(),
    }));
  }
}
