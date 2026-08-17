import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  CreatorDailyStat,
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
        messages: live.messages,
        giftCount: live.giftCount,
        giftCoins: live.giftCoins,
        speakingSeconds: live.speakingSeconds,
        uniqueVisitors: live.uniqueVisitors,
        peakParticipants: live.peakParticipants,
        engagementScore: this.rollup.roomEngagement(live),
      },
      revenue: { giftCoins: giftCoins.toString(), creatorCoins: creatorCoins.toString() },
      dailySeries: series.map((s) => this.roomDailyView(s)),
    };
  }

  /** A user's own creator analytics: today + lifetime totals + revenue + series. */
  async getMyAnalytics(userId: string, days: number): Promise<CreatorAnalyticsView> {
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
    ] = await Promise.all([
      this.counters.readCreator(userId, todayKey),
      this.repo.listCreatorDailyStats(userId, dateKeyDaysAgo(days)),
      this.repo.sumCreatorDailyStats(userId),
      this.repo.getRevenueReports({ userId, roomId: GLOBAL_ANALYTICS_UUID }),
      this.prisma.giftTransaction.aggregate({
        where: { receiverId: userId, status: GiftTxnStatus.COMPLETED },
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
    ]);

    let giftCoins = 0n;
    let creatorCoins = 0n;
    for (const r of revenue) {
      giftCoins += r.giftCoins;
      creatorCoins += r.creatorCoins;
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

    // Build complete dailySeries map for the requested days (ordered oldest -> newest)
    const map = new Map(seriesRows.map((s) => [s.dateKey, s]));
    const formattedSeries: CreatorDailyStatView[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const key = dateKeyDaysAgo(i);
      const existing = map.get(key);
      const dbTxn = dbEarningsByDate.get(key);

      if (key === todayKey) {
        const liveEarn = live.creatorEarnings;
        const liveCoins = live.giftCoinsReceived;
        const liveCount = live.giftsReceivedCount;

        const giftsCount = Math.max(liveCount, dbTxn?.giftsCount ?? 0, existing?.giftsReceivedCount ?? 0);
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

        formattedSeries.push({
          dateKey: key,
          giftsReceivedCount: giftsCount,
          giftCoinsReceived: coinsRec.toString(),
          creatorEarnings: earningsRec.toString(),
          roomsHosted: (existing?.roomsHosted ?? 0) + live.roomsHosted,
          speakingSeconds: (
            (existing ? Number(existing.speakingSeconds) : 0) + live.speakingSeconds
          ).toString(),
          engagementScore: existing?.engagementScore ?? this.rollup.creatorEngagement(live),
        });
      } else if (existing) {
        const giftsCount = Math.max(existing.giftsReceivedCount, dbTxn?.giftsCount ?? 0);
        const coinsRec = Math.max(Number(existing.giftCoinsReceived), dbTxn?.giftCoinsReceived ?? 0);
        const earningsRec = Math.max(Number(existing.creatorEarnings), dbTxn?.creatorEarnings ?? 0);

        formattedSeries.push({
          dateKey: key,
          giftsReceivedCount: giftsCount,
          giftCoinsReceived: coinsRec.toString(),
          creatorEarnings: earningsRec.toString(),
          roomsHosted: existing.roomsHosted,
          speakingSeconds: existing.speakingSeconds.toString(),
          engagementScore: existing.engagementScore,
        });
      } else if (dbTxn) {
        formattedSeries.push({
          dateKey: key,
          giftsReceivedCount: dbTxn.giftsCount,
          giftCoinsReceived: dbTxn.giftCoinsReceived.toString(),
          creatorEarnings: dbTxn.creatorEarnings.toString(),
          roomsHosted: 0,
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

    return {
      userId,
      today: {
        dateKey: todayKey,
        giftsReceivedCount: todayItem ? todayItem.giftsReceivedCount : live.giftsReceivedCount,
        giftCoinsReceived: todayItem ? Number(todayItem.giftCoinsReceived) : live.giftCoinsReceived,
        creatorEarnings: todayEarnings,
        roomsHosted: todayItem ? todayItem.roomsHosted : live.roomsHosted,
        speakingSeconds: todayItem ? Number(todayItem.speakingSeconds) : live.speakingSeconds,
        engagementScore: this.rollup.creatorEngagement(live),
      },
      totals: {
        giftsReceivedCount: Number(giftLifetime._count ?? 0),
        giftCoinsReceived: (giftLifetime._sum.totalCoinValue ?? 0n).toString(),
        // Wallet Earnings = Creator Earnings Lifetime (authoritative exact lifetime total)
        creatorEarnings: lifetimeEarningsTotal.toString(),
        roomsHosted: (lifetimeStats.roomsHosted ?? 0) + live.roomsHosted,
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
