import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface UpsertRoomDailyStatInput {
  dateKey: string;
  roomId: string;
  joins?: number;
  uniqueVisitors?: number;
  peakParticipants?: number;
  messages?: number;
  giftCount?: number;
  giftCoins?: bigint;
  speakingSeconds?: bigint;
  engagementScore?: number;
}

export interface UpsertCreatorDailyStatInput {
  dateKey: string;
  userId: string;
  giftsReceivedCount?: number;
  giftCoinsReceived?: bigint;
  creatorEarnings?: bigint;
  roomsHosted?: number;
  speakingSeconds?: bigint;
  engagementScore?: number;
}

export interface UpsertAnalyticsStatisticsInput {
  period: string;
  dateKey: string;
  metricType: string;
  count?: number;
  amount?: number;
}

export interface CreateSnapshotInput {
  domain: string;
  metricKey: string;
  metricValue: number;
}

export interface CreateAuditInput {
  reportId?: string;
  actorId?: string;
  action: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class VideoRoomAnalyticsProjectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  async upsertRoomDailyStat(input: UpsertRoomDailyStatInput) {
    return this.prisma.roomDailyStat.upsert({
      where: {
        dateKey_roomId: {
          dateKey: input.dateKey,
          roomId: input.roomId,
        },
      },
      create: {
        dateKey: input.dateKey,
        roomId: input.roomId,
        joins: input.joins ?? 0,
        uniqueVisitors: input.uniqueVisitors ?? 0,
        peakParticipants: input.peakParticipants ?? 0,
        messages: input.messages ?? 0,
        giftCount: input.giftCount ?? 0,
        giftCoins: input.giftCoins ?? BigInt(0),
        speakingSeconds: input.speakingSeconds ?? BigInt(0),
        engagementScore: input.engagementScore ?? 0,
      },
      update: {
        joins: input.joins ? { increment: input.joins } : undefined,
        uniqueVisitors: input.uniqueVisitors ? { increment: input.uniqueVisitors } : undefined,
        peakParticipants: input.peakParticipants ? input.peakParticipants : undefined,
        messages: input.messages ? { increment: input.messages } : undefined,
        giftCount: input.giftCount ? { increment: input.giftCount } : undefined,
        giftCoins: input.giftCoins ? { increment: input.giftCoins } : undefined,
        speakingSeconds: input.speakingSeconds ? { increment: input.speakingSeconds } : undefined,
        engagementScore: input.engagementScore ? { increment: input.engagementScore } : undefined,
      },
    });
  }

  async upsertCreatorDailyStat(input: UpsertCreatorDailyStatInput) {
    return this.prisma.creatorDailyStat.upsert({
      where: {
        dateKey_userId: {
          dateKey: input.dateKey,
          userId: input.userId,
        },
      },
      create: {
        dateKey: input.dateKey,
        userId: input.userId,
        giftsReceivedCount: input.giftsReceivedCount ?? 0,
        giftCoinsReceived: input.giftCoinsReceived ?? BigInt(0),
        creatorEarnings: input.creatorEarnings ?? BigInt(0),
        roomsHosted: input.roomsHosted ?? 0,
        speakingSeconds: input.speakingSeconds ?? BigInt(0),
        engagementScore: input.engagementScore ?? 0,
      },
      update: {
        giftsReceivedCount: input.giftsReceivedCount
          ? { increment: input.giftsReceivedCount }
          : undefined,
        giftCoinsReceived: input.giftCoinsReceived
          ? { increment: input.giftCoinsReceived }
          : undefined,
        creatorEarnings: input.creatorEarnings ? { increment: input.creatorEarnings } : undefined,
        roomsHosted: input.roomsHosted ? { increment: input.roomsHosted } : undefined,
        speakingSeconds: input.speakingSeconds ? { increment: input.speakingSeconds } : undefined,
        engagementScore: input.engagementScore ? { increment: input.engagementScore } : undefined,
      },
    });
  }

  async upsertAnalyticsStatistics(input: UpsertAnalyticsStatisticsInput) {
    return this.db.analyticsStatistics.upsert({
      where: {
        period_dateKey_metricType: {
          period: input.period,
          dateKey: input.dateKey,
          metricType: input.metricType,
        },
      },
      create: {
        period: input.period,
        dateKey: input.dateKey,
        metricType: input.metricType,
        count: input.count ?? 0,
        amount: input.amount ?? 0,
      },
      update: {
        count: input.count ? { increment: input.count } : undefined,
        amount: input.amount ? { increment: input.amount } : undefined,
      },
    });
  }

  async createSnapshot(input: CreateSnapshotInput) {
    return this.db.analyticsSnapshot.create({
      data: {
        domain: input.domain,
        metricKey: input.metricKey,
        metricValue: input.metricValue,
      },
    });
  }

  async createAudit(input: CreateAuditInput) {
    return this.db.analyticsAudit.create({
      data: {
        reportId: input.reportId,
        actorId: input.actorId,
        action: input.action,
        details: (input.details as any) ?? undefined,
      },
    });
  }

  async getRoomDailyStats(roomId: string, limit: number = 30) {
    return this.prisma.roomDailyStat.findMany({
      where: { roomId },
      orderBy: { dateKey: 'desc' },
      take: limit,
    });
  }

  async getCreatorDailyStats(userId: string, limit: number = 30) {
    return this.prisma.creatorDailyStat.findMany({
      where: { userId },
      orderBy: { dateKey: 'desc' },
      take: limit,
    });
  }

  async getAnalyticsSnapshots(domain: string, metricKey?: string, limit: number = 50) {
    return this.db.analyticsSnapshot.findMany({
      where: {
        domain,
        ...(metricKey ? { metricKey } : {}),
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  async getRoomStatistics(roomId: string) {
    return this.prisma.videoRoomStatistics.findUnique({
      where: { roomId },
    });
  }

  async updateRoomStatistics(roomId: string, data: Record<string, any>) {
    return this.prisma.videoRoomStatistics.update({
      where: { roomId },
      data,
    });
  }
}
