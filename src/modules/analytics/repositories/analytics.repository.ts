import { Injectable } from '@nestjs/common';
import {
  CreatorDailyStat,
  Prisma,
  RevenueReport,
  RoomActivity,
  RoomDailyStat,
  RoomVisitor,
  SpeakerSession,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Room Activity Operations ----

  async createRoomActivity(roomId: string): Promise<RoomActivity> {
    return this.prisma.roomActivity.create({
      data: {
        roomId,
        peakParticipants: 0,
        totalJoined: 0,
        totalGifts: 0,
        totalGiftCoins: 0n,
        totalSpeakingMinutes: 0,
        durationSeconds: 0,
      },
    });
  }

  async findRoomActivity(roomId: string): Promise<RoomActivity | null> {
    return this.prisma.roomActivity.findUnique({
      where: { roomId },
    });
  }

  async countUniqueVisitors(roomId: string): Promise<number> {
    const groups = await this.prisma.roomVisitor.groupBy({
      by: ['userId'],
      where: { roomId },
    });
    return groups.length;
  }

  async incrementRoomJoins(
    roomId: string,
    currentParticipantCount: number,
    userId?: string,
  ): Promise<void> {
    const activity = await this.prisma.roomActivity.findUnique({ where: { roomId } });
    if (!activity) return;

    const newPeak = Math.max(activity.peakParticipants, currentParticipantCount);

    let isNewVisitor = true;
    if (userId) {
      const priorCount = await this.prisma.roomVisitor.count({
        where: { roomId, userId },
      });
      if (priorCount > 1) {
        isNewVisitor = false;
      }
    }

    await this.prisma.roomActivity.update({
      where: { roomId },
      data: {
        totalJoined: isNewVisitor ? { increment: 1 } : undefined,
        peakParticipants: newPeak,
      },
    });
  }

  async incrementRoomGifts(roomId: string, coins: number): Promise<void> {
    await this.prisma.roomActivity.update({
      where: { roomId },
      data: {
        totalGifts: { increment: 1 },
        totalGiftCoins: { increment: BigInt(coins) },
      },
    });
  }

  async incrementRoomSpeaking(roomId: string, minutes: number): Promise<void> {
    await this.prisma.roomActivity.update({
      where: { roomId },
      data: {
        totalSpeakingMinutes: { increment: minutes },
      },
    });
  }

  async updateRoomDuration(roomId: string, durationSeconds: number): Promise<void> {
    await this.prisma.roomActivity.update({
      where: { roomId },
      data: { durationSeconds },
    });
  }

  // ---- Room Visitor (Attendance) Operations ----

  async createVisitor(roomId: string, userId: string): Promise<RoomVisitor> {
    return this.prisma.roomVisitor.create({
      data: {
        roomId,
        userId,
        joinedAt: new Date(),
        durationSeconds: 0,
      },
    });
  }

  async closeVisitor(roomId: string, userId: string): Promise<void> {
    const visitor = await this.prisma.roomVisitor.findFirst({
      where: { roomId, userId, leftAt: null },
      orderBy: { joinedAt: 'desc' },
    });

    if (!visitor) return;

    const leftAt = new Date();
    const durationSeconds = Math.max(
      0,
      Math.floor((leftAt.getTime() - visitor.joinedAt.getTime()) / 1000),
    );

    await this.prisma.roomVisitor.update({
      where: { id: visitor.id },
      data: {
        leftAt,
        durationSeconds,
      },
    });
  }

  async listVisitors(roomId: string, skip: number, take: number): Promise<[RoomVisitor[], number]> {
    const where = { roomId };
    const totalGroups = await this.prisma.roomVisitor.groupBy({
      by: ['userId'],
      where,
    });
    const total = totalGroups.length;

    if (total === 0) {
      return [[], 0];
    }

    const userGroups = await this.prisma.roomVisitor.groupBy({
      by: ['userId'],
      where,
      _max: { joinedAt: true },
      _sum: { durationSeconds: true },
      orderBy: { _max: { joinedAt: 'desc' } },
      skip,
      take,
    });

    const items: RoomVisitor[] = await Promise.all(
      userGroups.map(async (g) => {
        const latestSession = await this.prisma.roomVisitor.findFirst({
          where: { roomId, userId: g.userId },
          orderBy: { joinedAt: 'desc' },
        });
        return {
          id: latestSession?.id ?? g.userId,
          roomId,
          userId: g.userId,
          joinedAt: latestSession?.joinedAt ?? g._max.joinedAt ?? new Date(),
          leftAt: latestSession?.leftAt ?? null,
          durationSeconds: g._sum.durationSeconds ?? latestSession?.durationSeconds ?? 0,
          createdAt: latestSession?.createdAt ?? new Date(),
          updatedAt: latestSession?.updatedAt ?? new Date(),
        };
      }),
    );

    return [items, total];
  }

  /** Every visitor row whose join fell within a time window (unbounded — for a
   *  single live session's worth of visits, not a paginated listing). */
  listVisitorsInRange(roomId: string, start: Date, end: Date): Promise<RoomVisitor[]> {
    return this.prisma.roomVisitor.findMany({
      where: { roomId, joinedAt: { gte: start, lte: end } },
      orderBy: { joinedAt: 'asc' },
    });
  }

  // ---- Speaker Session Operations ----

  async createSpeakerSession(roomId: string, userId: string): Promise<SpeakerSession> {
    return this.prisma.speakerSession.create({
      data: {
        roomId,
        userId,
        joinedSeatAt: new Date(),
        speakingSeconds: 0,
      },
    });
  }

  async closeSpeakerSession(
    roomId: string,
    userId: string,
    extraSpeakingSeconds = 0,
  ): Promise<void> {
    const session = await this.prisma.speakerSession.findFirst({
      where: { roomId, userId, leftSeatAt: null },
      orderBy: { joinedSeatAt: 'desc' },
    });

    if (!session) return;

    await this.prisma.speakerSession.update({
      where: { id: session.id },
      data: {
        leftSeatAt: new Date(),
        speakingSeconds: {
          increment: extraSpeakingSeconds,
        },
      },
    });
  }

  async incrementSpeakingDuration(roomId: string, userId: string, seconds: number): Promise<void> {
    const session = await this.prisma.speakerSession.findFirst({
      where: { roomId, userId, leftSeatAt: null },
      orderBy: { joinedSeatAt: 'desc' },
    });

    if (!session) return;

    await this.prisma.speakerSession.update({
      where: { id: session.id },
      data: {
        speakingSeconds: {
          increment: seconds,
        },
      },
    });
  }

  async getSpeakingDurationsGrouped(
    roomId: string,
    skip: number,
    take: number,
  ): Promise<[{ userId: string; _sum: { speakingSeconds: number | null } }[], number]> {
    const where = { roomId };

    // To get the total count of distinct speakers, we find distinct userId counts
    const distinct = await this.prisma.speakerSession.findMany({
      where,
      distinct: ['userId'],
      select: { userId: true },
    });

    const groups = await this.prisma.speakerSession.groupBy({
      by: ['userId'],
      where,
      _sum: {
        speakingSeconds: true,
      },
      orderBy: {
        _sum: {
          speakingSeconds: 'desc',
        },
      },
      skip,
      take,
    });

    return [groups as any, distinct.length];
  }

  // ---- Revenue Operations ----

  async upsertRevenueReport(
    dateKey: string,
    roomId: string,
    userId: string,
    giftCoins: number,
    creatorCoins: number,
  ): Promise<RevenueReport> {
    return this.prisma.revenueReport.upsert({
      where: {
        dateKey_roomId_userId: {
          dateKey,
          roomId,
          userId,
        },
      },
      create: {
        dateKey,
        roomId,
        userId,
        giftCoins: BigInt(giftCoins),
        creatorCoins: BigInt(creatorCoins),
      },
      update: {
        giftCoins: { increment: BigInt(giftCoins) },
        creatorCoins: { increment: BigInt(creatorCoins) },
      },
    });
  }

  async getRevenueReports(filter: {
    startDate?: string;
    endDate?: string;
    roomId?: string;
    userId?: string;
  }): Promise<RevenueReport[]> {
    const where: Prisma.RevenueReportWhereInput = {};

    if (filter.startDate || filter.endDate) {
      where.dateKey = {};
      if (filter.startDate) {
        where.dateKey.gte = filter.startDate;
      }
      if (filter.endDate) {
        where.dateKey.lte = filter.endDate;
      }
    }

    if (filter.roomId) {
      where.roomId = filter.roomId;
    }
    if (filter.userId) {
      where.userId = filter.userId;
    }

    return this.prisma.revenueReport.findMany({
      where,
      orderBy: [{ dateKey: 'desc' }],
    });
  }

  // ---- Resolving Helpers ----

  async getUsersDetails(userIds: string[]) {
    if (userIds.length === 0) return [];
    return this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true },
    });
  }

  async getUserProfiles(userIds: string[]) {
    if (userIds.length === 0) return [];
    return this.prisma.userProfile.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, avatarKey: true },
    });
  }

  // ---- Daily rollup tables (AR-13) ----

  /** Idempotent overwrite of a room's daily rollup with the day's snapshot. */
  async upsertRoomDailyStat(data: {
    dateKey: string;
    roomId: string;
    joins: number;
    uniqueVisitors: number;
    peakParticipants: number;
    messages: number;
    giftCount: number;
    giftCoins: bigint;
    speakingSeconds: bigint;
    engagementScore: number;
  }): Promise<void> {
    const { dateKey, roomId, ...values } = data;
    await this.prisma.roomDailyStat.upsert({
      where: { dateKey_roomId: { dateKey, roomId } },
      create: { dateKey, roomId, ...values },
      update: values,
    });
  }

  /** Idempotent overwrite of a creator's daily rollup with the day's snapshot. */
  async upsertCreatorDailyStat(data: {
    dateKey: string;
    userId: string;
    giftsReceivedCount: number;
    giftCoinsReceived: bigint;
    creatorEarnings: bigint;
    roomsHosted: number;
    speakingSeconds: bigint;
    engagementScore: number;
  }): Promise<void> {
    const { dateKey, userId, ...values } = data;
    await this.prisma.creatorDailyStat.upsert({
      where: { dateKey_userId: { dateKey, userId } },
      create: { dateKey, userId, ...values },
      update: values,
    });
  }

  listRoomDailyStats(roomId: string, fromDateKey: string): Promise<RoomDailyStat[]> {
    return this.prisma.roomDailyStat.findMany({
      where: { roomId, dateKey: { gte: fromDateKey } },
      orderBy: { dateKey: 'desc' },
    });
  }

  listCreatorDailyStats(userId: string, fromDateKey: string): Promise<CreatorDailyStat[]> {
    return this.prisma.creatorDailyStat.findMany({
      where: { userId, dateKey: { gte: fromDateKey } },
      orderBy: { dateKey: 'desc' },
    });
  }

  /** Lifetime creator totals across all daily rollups. */
  async sumCreatorDailyStats(userId: string): Promise<{
    giftsReceivedCount: number;
    giftCoinsReceived: bigint;
    creatorEarnings: bigint;
    roomsHosted: number;
    speakingSeconds: bigint;
  }> {
    const agg = await this.prisma.creatorDailyStat.aggregate({
      where: { userId },
      _sum: {
        giftsReceivedCount: true,
        giftCoinsReceived: true,
        creatorEarnings: true,
        roomsHosted: true,
        speakingSeconds: true,
      },
    });
    return {
      giftsReceivedCount: agg._sum.giftsReceivedCount ?? 0,
      giftCoinsReceived: agg._sum.giftCoinsReceived ?? 0n,
      creatorEarnings: agg._sum.creatorEarnings ?? 0n,
      roomsHosted: agg._sum.roomsHosted ?? 0,
      speakingSeconds: agg._sum.speakingSeconds ?? 0n,
    };
  }

  /** Database-level aggregated average of visitor stay duration to eliminate N+1 memory issues. */
  async getAverageVisitorDuration(roomId: string): Promise<number> {
    const agg = await this.prisma.roomVisitor.aggregate({
      where: { roomId, leftAt: { not: null } },
      _avg: { durationSeconds: true },
    });
    return Math.round(agg._avg.durationSeconds ?? 0);
  }
}
