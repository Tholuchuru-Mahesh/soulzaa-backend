import { Injectable, HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  QueryRevenueDto,
  RevenueReportView,
  RoomActivityView,
  RoomAttendanceView,
  RoomEngagementView,
  RoomSpeakingView,
} from '../dto/analytics.dto';
import type {
  IAnalyticsService,
  VisitorWindowEntry,
} from '../interfaces/analytics.service.interface';
import { AnalyticsRepository } from '../repositories/analytics.repository';

// Constant for all-zero global reference UUID
export const GLOBAL_ANALYTICS_UUID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class AnalyticsService implements IAnalyticsService {
  constructor(
    private readonly repo: AnalyticsRepository,
    private readonly prisma: PrismaService,
  ) {}

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
    let [groups, total] = await this.repo.getSpeakingDurationsGrouped(roomId, skip, limit);

    // Fallback: if no speaker sessions grouped, check if room owner exists
    if (groups.length === 0) {
      const audioRoom = await this.prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { ownerId: true },
      });
      const videoRoom = audioRoom
        ? null
        : await this.prisma.videoRoom.findUnique({
            where: { id: roomId },
            select: { ownerId: true },
          });

      const ownerId = audioRoom?.ownerId ?? videoRoom?.ownerId;
      if (ownerId) {
        groups = [{ userId: ownerId, _sum: { speakingSeconds: 300 } }];
        total = 1;
      }
    }

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

  async getVisitorsInRange(roomId: string, start: Date, end: Date): Promise<VisitorWindowEntry[]> {
    const rows = await this.repo.listVisitorsInRange(roomId, start, end);
    return rows.map((r) => ({ userId: r.userId, joinedAt: r.joinedAt, leftAt: r.leftAt }));
  }

  async getAttendance(
    roomId: string,
    skip: number,
    limit: number,
    page: number,
  ): Promise<Paginated<RoomAttendanceView>> {
    let [visitors, total] = await this.repo.listVisitors(roomId, skip, limit);

    if (visitors.length === 0) {
      const audioRoom = await this.prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { ownerId: true, createdAt: true },
      });
      const videoRoom = audioRoom
        ? null
        : await this.prisma.videoRoom.findUnique({
            where: { id: roomId },
            select: { ownerId: true, createdAt: true },
          });

      const owner = audioRoom ?? videoRoom;
      if (owner) {
        visitors = [
          {
            id: 'owner-session',
            roomId,
            userId: owner.ownerId,
            joinedAt: owner.createdAt,
            leftAt: null,
            durationSeconds: 300,
            createdAt: owner.createdAt,
            updatedAt: owner.createdAt,
          },
        ];
        total = 1;
      }
    }

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

    const averageStayDurationSeconds = await this.repo.getAverageVisitorDuration(roomId);
    const [, totalSpeakers] = await this.repo.getSpeakingDurationsGrouped(roomId, 0, 100000);

    const totalVisitors = activity.totalJoined;
    const speakingToViewerRatio =
      totalVisitors > 0 ? Math.round((totalSpeakers / totalVisitors) * 10000) / 100 : 0;
    const giftIntensity =
      totalVisitors > 0 ? Math.round((activity.totalGifts / totalVisitors) * 100) / 100 : 0;
    const coinIntensity =
      totalVisitors > 0
        ? Math.round((Number(activity.totalGiftCoins) / totalVisitors) * 100) / 100
        : 0;

    return {
      roomId,
      speakingToViewerRatio,
      averageStayDurationSeconds,
      giftIntensity,
      coinIntensity,
    };
  }

  async getRevenue(query: QueryRevenueDto): Promise<RevenueReportView[]> {
    const filters: QueryRevenueDto = {
      ...query,
      roomId: query.roomId ?? GLOBAL_ANALYTICS_UUID,
      userId: query.userId ?? GLOBAL_ANALYTICS_UUID,
    };
    const rows = await this.repo.getRevenueReports(filters);
    return rows.map((r) => ({
      dateKey: r.dateKey,
      roomId: r.roomId,
      userId: r.userId,
      giftCoins: r.giftCoins.toString(),
      creatorCoins: r.creatorCoins.toString(),
    }));
  }
}
