import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  CreatorDailyStat,
  GiftContextType,
  GiftTxnStatus,
  RoomActivity,
  RoomDailyStat,
  RoomMemberRole,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import type { PlatformRole } from 'src/common/constants';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { PrismaService } from 'src/infra/prisma/prisma.service';
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
    private readonly prisma: PrismaService,
  ) {}

  /** Owner/admin-only room analytics: cumulative + today + revenue + daily series. */
  async getRoomReport(
    actor: AnalyticsActor,
    roomId: string,
    days: number,
  ): Promise<RoomReportView> {
    await this.assertRoomManager(actor, roomId);

    const effectiveDays = days > 0 ? days : 30;
    const dateKey = dateKeyOf();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - effectiveDays - 1);
    fromDate.setHours(0, 0, 0, 0);

    const [activity, live, series, revenue, rangeGifts, rangeVisitors] = await Promise.all([
      this.repo.findRoomActivity(roomId),
      this.counters.readRoom(roomId, dateKey),
      this.repo.listRoomDailyStats(roomId, dateKeyDaysAgo(effectiveDays)),
      this.repo.getRevenueReports({ roomId, userId: GLOBAL_ANALYTICS_UUID }),
      this.prisma.giftTransaction.findMany({
        where: {
          contextId: roomId,
          status: GiftTxnStatus.COMPLETED,
          createdAt: { gte: fromDate },
        },
        select: {
          totalCoinValue: true,
          creatorEarnings: true,
          createdAt: true,
        },
      }),
      this.prisma.roomVisitor.findMany({
        where: {
          roomId,
          joinedAt: { gte: fromDate },
        },
        select: {
          userId: true,
          joinedAt: true,
        },
      }),
    ]);

    let giftCoins = 0n;
    let creatorCoins = 0n;
    for (const r of revenue) {
      giftCoins += r.giftCoins;
      creatorCoins += r.creatorCoins;
    }

    let dbGiftsCount = 0;
    if (giftCoins === 0n) {
      const isVideo = await this.prisma.videoRoom.findUnique({
        where: { id: roomId },
        select: { id: true },
      });
      const roomContextType = isVideo ? GiftContextType.VIDEO_ROOM : GiftContextType.AUDIO_ROOM;
      const dbGifts = await this.prisma.giftTransaction.aggregate({
        where: { contextId: roomId, status: GiftTxnStatus.COMPLETED, contextType: roomContextType },
        _sum: { totalCoinValue: true, creatorEarnings: true },
        _count: true,
      });
      giftCoins = dbGifts._sum.totalCoinValue ?? 0n;
      creatorCoins = dbGifts._sum.creatorEarnings ?? 0n;
      dbGiftsCount = dbGifts._count ?? 0;
    }

    const uniqueVisitors = await this.repo.countUniqueVisitors(roomId);
    let activityView = activity ? this.roomActivityView(activity, uniqueVisitors) : null;
    if (!activityView) {
      activityView = {
        roomId,
        peakParticipants: Math.max(live.peakParticipants, 1),
        totalJoined: Math.max(uniqueVisitors, live.uniqueVisitors, live.joins > 0 ? 1 : 0),
        totalGifts: Math.max(live.giftCount, dbGiftsCount),
        totalGiftCoins: (giftCoins + BigInt(live.giftCoins)).toString(),
        totalSpeakingMinutes: Math.round(live.speakingSeconds / 60),
        durationSeconds: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    // Aggregate DB gifts by dateKey
    const dbGiftsByDate = new Map<string, { giftCoins: number; giftsCount: number }>();
    for (const g of rangeGifts) {
      const key = dateKeyOf(g.createdAt);
      const existing = dbGiftsByDate.get(key) || { giftCoins: 0, giftsCount: 0 };
      existing.giftCoins += Number(g.totalCoinValue);
      existing.giftsCount += 1;
      dbGiftsByDate.set(key, existing);
    }

    // Aggregate DB visitors by dateKey
    const dbVisitorsByDate = new Map<string, { joins: number; uniqueUsers: Set<string> }>();
    for (const v of rangeVisitors) {
      const key = dateKeyOf(v.joinedAt);
      const existing = dbVisitorsByDate.get(key) || { joins: 0, uniqueUsers: new Set<string>() };
      existing.joins += 1;
      existing.uniqueUsers.add(v.userId);
      dbVisitorsByDate.set(key, existing);
    }

    // Build complete dailySeries map for the requested days (ordered oldest -> newest)
    const map = new Map(series.map((s) => [s.dateKey, s]));
    const formattedSeries: RoomDailyStatView[] = [];

    for (let i = effectiveDays - 1; i >= 0; i--) {
      const key = dateKeyDaysAgo(i);
      const existing = map.get(key);
      const dbGift = dbGiftsByDate.get(key);
      const dbVis = dbVisitorsByDate.get(key);

      if (key === dateKey) {
        const joins = Math.max(live.joins, dbVis?.joins ?? 0, existing?.joins ?? 0);
        const uVis = Math.max(
          live.uniqueVisitors,
          dbVis?.uniqueUsers.size ?? 0,
          existing?.uniqueVisitors ?? 0,
        );
        const peak = Math.max(live.peakParticipants, existing?.peakParticipants ?? 1);
        const messages = Math.max(live.messages, existing?.messages ?? 0);
        const gifts = Math.max(live.giftCount, dbGift?.giftsCount ?? 0, existing?.giftCount ?? 0);
        const coins = Math.max(
          live.giftCoins,
          dbGift?.giftCoins ?? 0,
          existing ? Number(existing.giftCoins) : 0,
        );
        const speaking = (existing ? Number(existing.speakingSeconds) : 0) + live.speakingSeconds;

        formattedSeries.push({
          dateKey: key,
          joins,
          uniqueVisitors: uVis,
          peakParticipants: peak,
          messages,
          giftCount: gifts,
          giftCoins: coins.toString(),
          speakingSeconds: speaking.toString(),
          engagementScore: existing?.engagementScore ?? this.rollup.roomEngagement(live),
        });
      } else if (existing) {
        const gifts = Math.max(existing.giftCount, dbGift?.giftsCount ?? 0);
        const coins = Math.max(Number(existing.giftCoins), dbGift?.giftCoins ?? 0);
        const joins = Math.max(existing.joins, dbVis?.joins ?? 0);
        const uVis = Math.max(existing.uniqueVisitors, dbVis?.uniqueUsers.size ?? 0);

        formattedSeries.push({
          dateKey: key,
          joins,
          uniqueVisitors: uVis,
          peakParticipants: existing.peakParticipants,
          messages: existing.messages,
          giftCount: gifts,
          giftCoins: coins.toString(),
          speakingSeconds: existing.speakingSeconds.toString(),
          engagementScore: existing.engagementScore,
        });
      } else if (dbGift || dbVis) {
        formattedSeries.push({
          dateKey: key,
          joins: dbVis?.joins ?? 0,
          uniqueVisitors: dbVis?.uniqueUsers.size ?? 0,
          peakParticipants: dbVis?.uniqueUsers.size ? Math.min(dbVis.uniqueUsers.size, 10) : 1,
          messages: 0,
          giftCount: dbGift?.giftsCount ?? 0,
          giftCoins: (dbGift?.giftCoins ?? 0).toString(),
          speakingSeconds: '0',
          engagementScore: 0,
        });
      } else {
        formattedSeries.push({
          dateKey: key,
          joins: 0,
          uniqueVisitors: 0,
          peakParticipants: 0,
          messages: 0,
          giftCount: 0,
          giftCoins: '0',
          speakingSeconds: '0',
          engagementScore: 0,
        });
      }
    }

    return {
      roomId,
      activity: activityView,
      today: {
        dateKey,
        joins: live.joins,
        messages: live.messages,
        giftCount: Math.max(live.giftCount, dbGiftsCount),
        giftCoins: live.giftCoins > 0 ? live.giftCoins : Number(giftCoins),
        speakingSeconds: live.speakingSeconds,
        uniqueVisitors: live.uniqueVisitors,
        peakParticipants: live.peakParticipants,
        engagementScore: this.rollup.roomEngagement(live),
      },
      revenue: { giftCoins: giftCoins.toString(), creatorCoins: creatorCoins.toString() },
      dailySeries: formattedSeries,
    };
  }

  /** A user's own creator analytics: today + lifetime totals + revenue + series (optionally scoped to AUDIO_ROOM or VIDEO_ROOM). */
  async getMyAnalytics(
    userId: string,
    days: number,
    roomType?: GiftContextType,
  ): Promise<CreatorAnalyticsView> {
    const effectiveRoomType = roomType ?? GiftContextType.AUDIO_ROOM;
    const now = new Date();
    const todayKey = dateKeyOf(now);

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days - 1);
    fromDate.setHours(0, 0, 0, 0);

    const [
      live,
      seriesRows,
      lifetimeStats,
      revenue,
      giftLifetime,
      treasurePkSums,
      rangeGifts,
      rangeLedger,
      audioRooms,
      videoRooms,
    ] = await Promise.all([
      this.counters.readCreator(userId, todayKey),
      this.repo.listCreatorDailyStats(userId, dateKeyDaysAgo(days)),
      this.repo.sumCreatorDailyStats(userId),
      this.repo.getRevenueReports({ userId, roomId: GLOBAL_ANALYTICS_UUID }),
      this.prisma.giftTransaction.aggregate({
        where: {
          receiverId: userId,
          status: GiftTxnStatus.COMPLETED,
          contextType: effectiveRoomType,
        },
        _sum: { creatorEarnings: true, totalCoinValue: true },
        _count: true,
      }),
      this.prisma.ledgerEntry.aggregate({
        where: {
          wallet: { userId },
          reason: { in: [WalletTxnReason.TREASURE_BOX, WalletTxnReason.PK_REWARD] },
          currency: WalletCurrency.GOLD,
        },
        _sum: { amount: true },
      }),
      this.prisma.giftTransaction.findMany({
        where: {
          receiverId: userId,
          status: GiftTxnStatus.COMPLETED,
          contextType: effectiveRoomType,
          createdAt: { gte: fromDate },
        },
        select: {
          createdAt: true,
          creatorEarnings: true,
          totalCoinValue: true,
        },
      }),
      this.prisma.ledgerEntry.findMany({
        where: {
          wallet: { userId },
          reason: { in: [WalletTxnReason.TREASURE_BOX, WalletTxnReason.PK_REWARD] },
          currency: WalletCurrency.GOLD,
          createdAt: { gte: fromDate },
        },
        select: {
          createdAt: true,
          amount: true,
        },
      }),
      this.prisma.audioRoom.findMany({
        where: { ownerId: userId, deletedAt: null },
        select: { id: true, createdAt: true },
      }),
      this.prisma.videoRoom.findMany({
        where: { ownerId: userId, deletedAt: null },
        select: { id: true, createdAt: true },
      }),
    ]);

    let giftCoins = 0n;
    let creatorCoins = 0n;
    if (effectiveRoomType === GiftContextType.AUDIO_ROOM) {
      for (const r of revenue) {
        giftCoins += r.giftCoins;
        creatorCoins += r.creatorCoins;
      }
    }

    if (giftCoins === 0n || effectiveRoomType === GiftContextType.VIDEO_ROOM) {
      giftCoins = giftLifetime._sum.totalCoinValue ?? 0n;
      creatorCoins = giftLifetime._sum.creatorEarnings ?? 0n;
    }

    const lifetimeGifts = Number(giftLifetime._sum.creatorEarnings ?? 0n);
    const treasurePkTotal = Number(treasurePkSums._sum?.amount ?? 0n);
    const lifetimeEarningsTotal = lifetimeGifts + treasurePkTotal;

    // Aggregate DB completed transactions per dateKey
    const dbEarningsByDate = new Map<
      string,
      { creatorEarnings: number; giftCoinsReceived: number; giftsCount: number }
    >();

    for (const g of rangeGifts) {
      const key = dateKeyOf(g.createdAt);
      const existing = dbEarningsByDate.get(key) || {
        creatorEarnings: 0,
        giftCoinsReceived: 0,
        giftsCount: 0,
      };
      existing.creatorEarnings += Number(g.creatorEarnings);
      existing.giftCoinsReceived += Number(g.totalCoinValue);
      existing.giftsCount += 1;
      dbEarningsByDate.set(key, existing);
    }

    for (const l of rangeLedger) {
      const key = dateKeyOf(l.createdAt);
      const existing = dbEarningsByDate.get(key) || {
        creatorEarnings: 0,
        giftCoinsReceived: 0,
        giftsCount: 0,
      };
      existing.creatorEarnings += Number(l.amount);
      dbEarningsByDate.set(key, existing);
    }

    // Aggregate DB rooms hosted by dateKey and total
    const dbRoomsByDate = new Map<string, number>();
    const roomsToCount = effectiveRoomType === GiftContextType.VIDEO_ROOM ? videoRooms : audioRooms;
    for (const r of roomsToCount) {
      const key = dateKeyOf(r.createdAt);
      dbRoomsByDate.set(key, (dbRoomsByDate.get(key) ?? 0) + 1);
    }
    const totalDbRooms = roomsToCount.length;
    const totalRoomsHosted = Math.max(
      totalDbRooms,
      effectiveRoomType === GiftContextType.AUDIO_ROOM
        ? (lifetimeStats.roomsHosted ?? 0) + live.roomsHosted
        : totalDbRooms,
    );

    // Build complete dailySeries map for the requested days (ordered oldest -> newest)
    const map = new Map(seriesRows.map((s) => [s.dateKey, s]));
    const formattedSeries: CreatorDailyStatView[] = [];

    const isAudio = effectiveRoomType === GiftContextType.AUDIO_ROOM;
    for (let i = days - 1; i >= 0; i--) {
      const key = dateKeyDaysAgo(i);
      const existing = isAudio ? map.get(key) : undefined;
      const dbTxn = dbEarningsByDate.get(key);
      const dbRooms = dbRoomsByDate.get(key) ?? 0;

      if (key === todayKey) {
        const liveEarn = isAudio ? live.creatorEarnings : 0;
        const liveCoins = isAudio ? live.giftCoinsReceived : 0;
        const liveCount = isAudio ? live.giftsReceivedCount : 0;

        const giftsCount = Math.max(
          liveCount,
          dbTxn?.giftsCount ?? 0,
          existing?.giftsReceivedCount ?? 0,
        );
        const coinsRec = Math.max(
          liveCoins,
          dbTxn?.giftCoinsReceived ?? 0,
          existing ? Number(existing.giftCoinsReceived) : 0,
        );
        const earningsRec = Math.max(
          liveEarn,
          dbTxn?.creatorEarnings ?? 0,
          existing ? Number(existing.creatorEarnings) : 0,
        );
        const roomsRec = Math.max(
          isAudio ? live.roomsHosted : 0,
          dbRooms,
          existing?.roomsHosted ?? 0,
        );

        formattedSeries.push({
          dateKey: key,
          giftsReceivedCount: giftsCount,
          giftCoinsReceived: coinsRec.toString(),
          creatorEarnings: earningsRec.toString(),
          roomsHosted: roomsRec,
          speakingSeconds: (
            (existing ? Number(existing.speakingSeconds) : 0) + (isAudio ? live.speakingSeconds : 0)
          ).toString(),
          engagementScore: existing?.engagementScore ?? (isAudio ? this.rollup.creatorEngagement(live) : 0),
        });
      } else if (existing) {
        const giftsCount = Math.max(existing.giftsReceivedCount, dbTxn?.giftsCount ?? 0);
        const coinsRec = Math.max(
          Number(existing.giftCoinsReceived),
          dbTxn?.giftCoinsReceived ?? 0,
        );
        const earningsRec = Math.max(Number(existing.creatorEarnings), dbTxn?.creatorEarnings ?? 0);
        const roomsRec = Math.max(existing.roomsHosted, dbRooms);

        formattedSeries.push({
          dateKey: key,
          giftsReceivedCount: giftsCount,
          giftCoinsReceived: coinsRec.toString(),
          creatorEarnings: earningsRec.toString(),
          roomsHosted: roomsRec,
          speakingSeconds: existing.speakingSeconds.toString(),
          engagementScore: existing.engagementScore,
        });
      } else if (dbTxn || dbRooms > 0) {
        formattedSeries.push({
          dateKey: key,
          giftsReceivedCount: dbTxn?.giftsCount ?? 0,
          giftCoinsReceived: (dbTxn?.giftCoinsReceived ?? 0).toString(),
          creatorEarnings: (dbTxn?.creatorEarnings ?? 0).toString(),
          roomsHosted: dbRooms,
          speakingSeconds: '0',
          engagementScore: 0,
        });
      } else {
        formattedSeries.push({
          dateKey: key,
          giftsReceivedCount: 0,
          giftCoinsReceived: '0',
          creatorEarnings: '0',
          roomsHosted: 0,
          speakingSeconds: '0',
          engagementScore: 0,
        });
      }
    }

    const todayItem = formattedSeries.find((s) => s.dateKey === todayKey);
    const todayEarnings = todayItem ? Number(todayItem.creatorEarnings) : live.creatorEarnings;
    const todayRooms = todayItem
      ? todayItem.roomsHosted
      : Math.max(live.roomsHosted, dbRoomsByDate.get(todayKey) ?? 0);

    return {
      userId,
      today: {
        dateKey: todayKey,
        giftsReceivedCount: todayItem ? todayItem.giftsReceivedCount : live.giftsReceivedCount,
        giftCoinsReceived: todayItem ? Number(todayItem.giftCoinsReceived) : live.giftCoinsReceived,
        creatorEarnings: todayEarnings,
        roomsHosted: todayRooms,
        speakingSeconds: todayItem ? Number(todayItem.speakingSeconds) : live.speakingSeconds,
        engagementScore: this.rollup.creatorEngagement(live),
      },
      totals: {
        giftsReceivedCount: Number(giftLifetime._count ?? 0),
        giftCoinsReceived: (giftLifetime._sum.totalCoinValue ?? 0n).toString(),
        // Wallet Earnings = Creator Earnings Lifetime (authoritative exact lifetime total)
        creatorEarnings: lifetimeEarningsTotal.toString(),
        roomsHosted: totalRoomsHosted,
        speakingSeconds: (
          (lifetimeStats.speakingSeconds ?? 0n) + BigInt(live.speakingSeconds)
        ).toString(),
        audioHours:
          Math.round(
            ((Number(lifetimeStats.speakingSeconds ?? 0n) + live.speakingSeconds) / 3600) * 100,
          ) / 100,
      },
      revenue: { giftCoins: giftCoins.toString(), creatorCoins: creatorCoins.toString() },
      dailySeries: formattedSeries,
    };
  }

  /** Owner + room managers + platform admins may read a room's analytics. */
  async assertRoomManager(actor: AnalyticsActor, roomId: string): Promise<void> {
    if (actor.roles.some((r) => (ANALYTICS_ADMIN_ROLES as readonly string[]).includes(r))) return;

    const [audioRoom, videoRoom] = await Promise.all([
      this.prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { ownerId: true },
      }),
      this.prisma.videoRoom.findUnique({
        where: { id: roomId },
        select: { ownerId: true },
      }),
    ]);

    if (audioRoom?.ownerId === actor.id || videoRoom?.ownerId === actor.id) {
      return;
    }

    const role = await this.rooms.getEffectiveRole(roomId, actor.id);
    if (role && ANALYTICS_ROOM_MANAGER_ROLES.includes(role as RoomMemberRole)) return;
    throw new BusinessException(
      ERROR_CODES.ANALYTICS_NOT_AUTHORIZED,
      'Only the room owner or an admin can view this room’s analytics.',
      HttpStatus.FORBIDDEN,
    );
  }

  // ---- views ----

  private roomActivityView(a: RoomActivity, uniqueVisitors?: number) {
    return {
      roomId: a.roomId,
      peakParticipants: a.peakParticipants,
      totalJoined:
        uniqueVisitors !== undefined && uniqueVisitors > 0 ? uniqueVisitors : a.totalJoined,
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
