import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  ANALYTICS_SERVICE,
  type IAnalyticsService,
} from 'src/modules/analytics/interfaces/analytics.service.interface';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
  type LiveSessionView,
  type RoomView,
} from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import {
  GIFTS_SERVICE,
  type IGiftsService,
} from 'src/modules/gifts/interfaces/gifts.service.interface';
import {
  PK_BATTLE_SERVICE,
  type IPkBattleService,
  type PkHistoryFilter,
} from 'src/modules/audio-rooms/interfaces/pk-battle.service.interface';
import {
  SOCIAL_SERVICE,
  type ISocialService,
} from 'src/modules/social/interfaces/social.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { WithdrawalApprovalService } from 'src/modules/withdrawals/services/withdrawal-approval.service';
import { WithdrawalConfigurationService } from 'src/modules/withdrawals/services/withdrawal-configuration.service';
import { WithdrawalHistoryService } from 'src/modules/withdrawals/services/withdrawal-history.service';
import { WithdrawalService } from 'src/modules/withdrawals/services/withdrawal.service';
import type {
  LiveHistoryEntryView,
  LiveHistoryDetailView,
  LiveHistoryTopGifterView,
  LiveHistoryGiftBreakdownView,
} from '../interfaces/live-history.interface';
import type { TopFanView } from '../interfaces/top-fan.interface';
import { peakConcurrent } from '../utils/concurrency.util';

/**
 * Creator Center — a thin composition layer over the existing audio-rooms,
 * analytics, gifts and social domains. Owns no financial or room-lifecycle
 * data itself; it only answers creator-scoped questions ("what happened
 * during MY broadcasts") that none of those modules expose on their own.
 */
@Injectable()
export class CreatorCenterService {
  constructor(
    @Inject(AUDIO_ROOMS_SERVICE) private readonly rooms: IAudioRoomsService,
    @Inject(ANALYTICS_SERVICE) private readonly analytics: IAnalyticsService,
    @Inject(GIFTS_SERVICE) private readonly gifts: IGiftsService,
    @Inject(SOCIAL_SERVICE) private readonly social: ISocialService,
    @Inject(PK_BATTLE_SERVICE) private readonly pk: IPkBattleService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
    private readonly withdrawals: WithdrawalService,
    private readonly withdrawalHistory: WithdrawalHistoryService,
    private readonly withdrawalConfig: WithdrawalConfigurationService,
    private readonly withdrawalApproval: WithdrawalApprovalService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly media?: MediaUrlResolver,
  ) {}

  // ---- Settlement (self-scoped wrapper over the withdrawal engine) ----
  //
  // The underlying /withdrawals/* REST surface is admin-console-shaped: reads
  // are gated by admin-tier permissions (withdrawal.view / .history.view /
  // .configuration.manage) and accept an arbitrary target userId, which
  // ordinary creators don't hold and shouldn't be able to pass. These methods
  // are the self-service seam instead — always scoped to the JWT-derived
  // caller, delegating every business rule (min/max, balance, daily limit,
  // one-pending-at-a-time, refund-on-cancel) to the existing services.

  requestSettlement(
    userId: string,
    input: { amountCoins: number; payoutMethod?: string; payoutDetails?: Record<string, unknown> },
  ) {
    return this.withdrawals.requestWithdrawal({
      userId,
      amountCoins: BigInt(input.amountCoins),
      payoutMethod: input.payoutMethod,
      payoutDetails: input.payoutDetails,
    });
  }

  getSettlementHistory(userId: string, page: number, limit: number, status?: string) {
    return this.withdrawalHistory.getWithdrawalHistory(userId, { page, limit, status });
  }

  async getSettlementDetail(userId: string, settlementId: string) {
    const req = await this.withdrawals.getWithdrawalRequest(settlementId);
    if (!req || req.userId !== userId) {
      throw new BusinessException(
        ERROR_CODES.NOT_FOUND,
        'Settlement request not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return req;
  }

  cancelSettlement(userId: string, settlementId: string) {
    // Ownership is enforced inside reviewWithdrawal itself for CANCEL.
    return this.withdrawalApproval.reviewWithdrawal({
      requestId: settlementId,
      reviewerId: userId,
      action: 'CANCEL',
    });
  }

  /** Global config (min/max/fee/limits) — no per-user data, safe to expose read-only. */
  getSettlementConfig() {
    return this.withdrawalConfig.getWithdrawalConfig();
  }

  async getTopFans(
    creatorId: string,
    period: 'today' | 'week' | 'month' | 'all',
    limit: number,
  ): Promise<TopFanView[]> {
    const ranked = await this.gifts.getTopFans(creatorId, period, limit);
    if (ranked.length === 0) return [];

    const cards = await this.profiles.getCards(ranked.map((r) => r.userId));
    const cardById = new Map(cards.map((c) => [c.id, c]));

    return ranked.map((r) => {
      const card = cardById.get(r.userId);
      return {
        rank: r.rank,
        userId: r.userId,
        username: card?.username ?? null,
        fullName: card?.fullName ?? null,
        avatarUrl: card?.avatarUrl ?? null,
        level: card?.level ?? 1,
        vipLevel: card?.vipLevel ?? 0,
        totalCoins: r.totalCoins,
        giftCount: r.giftCount,
        lastGiftAt: r.lastGiftAt,
      };
    });
  }

  async getLiveHistory(
    userId: string,
    page: number,
    limit: number,
    skip: number,
    roomId?: string,
    roomType?: string,
  ): Promise<Paginated<LiveHistoryEntryView>> {
    let audioSessions: LiveSessionView[] = [];
    if (!roomId && roomType !== 'VIDEO') {
      try {
        const audioResult = await this.rooms.listMyLiveSessions(userId, 0, 100);
        audioSessions = [...audioResult.rows];
      } catch {
        audioSessions = [];
      }

      if (this.prisma) {
        try {
          const directAudioRooms = await this.prisma.audioRoom.findMany({
            where: { ownerId: userId, deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 100,
          });
          const existingRoomIds = new Set(audioSessions.map((s) => s.roomId));
          for (const ar of directAudioRooms) {
            if (!existingRoomIds.has(ar.id)) {
              audioSessions.push({
                id: ar.id,
                roomId: ar.id,
                startedAt: ar.createdAt,
                endedAt: ar.endedAt,
                durationSeconds: ar.endedAt
                  ? Math.max(0, Math.floor((ar.endedAt.getTime() - ar.createdAt.getTime()) / 1000))
                  : null,
                status: ar.status === 'LIVE' ? 'LIVE' : 'ENDED',
              });
            }
          }
        } catch {
          // continue with existing audioSessions
        }
      }
    }

    let videoSessions: (LiveSessionView & { isVideo?: boolean })[] = [];
    if (this.prisma) {
      try {
        const seenSessionIds = new Set<string>();

        // 1. Query VideoBroadcastSession table (each session represents a separate broadcast)
        const broadcastSessions = await (this.prisma as any).videoBroadcastSession.findMany({
          where: {
            OR: [
              { hostId: userId },
              { room: { ownerId: userId } },
            ],
            ...(roomId ? { roomId } : {}),
          },
          include: { room: true },
          orderBy: { startedAt: 'desc' },
          take: 200,
        }).catch(() => []);

        for (const bs of broadcastSessions) {
          if (!seenSessionIds.has(bs.id)) {
            seenSessionIds.add(bs.id);
            const duration = bs.durationSeconds || (bs.endedAt
              ? Math.max(0, Math.floor((bs.endedAt.getTime() - bs.startedAt.getTime()) / 1000))
              : (bs.status === 'LIVE' ? Math.max(0, Math.floor((Date.now() - bs.startedAt.getTime()) / 1000)) : null));
            videoSessions.push({
              id: bs.id,
              roomId: bs.roomId,
              startedAt: bs.startedAt,
              endedAt: bs.endedAt,
              durationSeconds: duration,
              status: bs.status === 'LIVE' ? 'LIVE' : 'ENDED',
              isVideo: true,
              name: bs.title || bs.room?.name,
              imageKey: bs.imageKey || bs.room?.imageKey,
            } as any);
          }
        }

        // 2. Fallback: If no broadcastSessions found (e.g. rooms created before broadcast migration), load from VideoRoom
        if (videoSessions.length === 0) {
          const videoRooms = await this.prisma.videoRoom.findMany({
            where: {
              ...(roomId ? { id: roomId } : {
                OR: [
                  { ownerId: userId },
                  { createdBy: userId },
                ],
              }),
              deletedAt: null,
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
          });

          for (const vr of videoRooms) {
            if (!seenSessionIds.has(vr.id)) {
              seenSessionIds.add(vr.id);
              const duration = vr.endedAt
                ? Math.max(0, Math.floor((vr.endedAt.getTime() - vr.createdAt.getTime()) / 1000))
                : (vr.status === 'LIVE' ? Math.max(0, Math.floor((Date.now() - vr.createdAt.getTime()) / 1000)) : null);
              videoSessions.push({
                id: vr.id,
                roomId: vr.id,
                startedAt: vr.createdAt,
                endedAt: vr.endedAt,
                durationSeconds: duration,
                status: vr.status === 'LIVE' ? 'LIVE' : 'ENDED',
                isVideo: true,
              });
            }
          }
        }
      } catch {
        videoSessions = [];
      }
    }

    // Merge and sort newest first
    const allSessions = [...audioSessions, ...videoSessions].sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
    );

    const total = allSessions.length;
    const pagedSessions = allSessions.slice(skip, skip + limit);
    const items = await this.enrichSessions(userId, pagedSessions);
    return buildPaginated(items, total, page, limit);
  }

  async getLiveHistoryDetail(userId: string, sessionId: string): Promise<LiveHistoryDetailView> {
    let session: (LiveSessionView & { isVideo?: boolean }) | null = await this.rooms.getMyLiveSession(userId, sessionId).catch(() => null);
    if (!session && this.prisma) {
      // 1. Check VideoBroadcastSession by unique sessionId
      const bs = await (this.prisma as any).videoBroadcastSession.findUnique({
        where: { id: sessionId },
        include: { room: true },
      }).catch(() => null);

      if (bs) {
        session = {
          id: bs.id,
          roomId: bs.roomId,
          startedAt: bs.startedAt,
          endedAt: bs.endedAt,
          durationSeconds: bs.durationSeconds || (bs.endedAt
            ? Math.max(0, Math.floor((bs.endedAt.getTime() - bs.startedAt.getTime()) / 1000))
            : (bs.status === 'LIVE' ? Math.max(0, Math.floor((Date.now() - bs.startedAt.getTime()) / 1000)) : null)),
          status: bs.status === 'LIVE' ? 'LIVE' : 'ENDED',
          isVideo: true,
          name: bs.title || bs.room?.name,
          imageKey: bs.imageKey || bs.room?.imageKey,
          paidEntryEnabled: bs.paidEntryEnabled ?? false,
          entryFee: bs.entryFee ? Number(bs.entryFee) : 0,
          paidEntrants: bs.totalPaidEntrants ?? 0,
          entryRevenue: bs.totalEntryRevenue ? Number(bs.totalEntryRevenue) : 0,
          entryCreatorEarnings: bs.entryCreatorEarnings ? Number(bs.entryCreatorEarnings) : 0,
        } as any;
      } else {
        // Fallback: Check VideoRoom by ID
        const vr = await this.prisma.videoRoom.findFirst({
          where: {
            id: sessionId,
            OR: [
              { ownerId: userId },
              { createdBy: userId },
            ],
            deletedAt: null,
          },
        });
        if (vr) {
          session = {
            id: vr.id,
            roomId: vr.id,
            startedAt: vr.createdAt,
            endedAt: vr.endedAt,
            durationSeconds: vr.endedAt
              ? Math.max(0, Math.floor((vr.endedAt.getTime() - vr.createdAt.getTime()) / 1000))
              : (vr.status === 'LIVE' ? Math.max(0, Math.floor((Date.now() - vr.createdAt.getTime()) / 1000)) : null),
            status: vr.status === 'LIVE' ? 'LIVE' : 'ENDED',
            isVideo: true,
          };
        } else {
          const vMember = await this.prisma.videoRoomMember.findFirst({
            where: { roomId: sessionId, userId },
          }).catch(() => null);
          if (vMember) {
            const r = await this.prisma.videoRoom.findUnique({
              where: { id: sessionId },
            }).catch(() => null);
            if (r && !r.deletedAt) {
              session = {
                id: vMember.roomId,
                roomId: vMember.roomId,
                startedAt: vMember.joinedAt ?? r.createdAt,
                endedAt: vMember.leftAt ?? r.endedAt,
                durationSeconds: vMember.leftAt
                  ? Math.max(0, Math.floor((vMember.leftAt.getTime() - vMember.joinedAt.getTime()) / 1000))
                  : (r.status === 'LIVE' ? Math.max(0, Math.floor((Date.now() - (vMember.joinedAt ?? r.createdAt).getTime()) / 1000)) : null),
                status: r.status === 'LIVE' ? 'LIVE' : 'ENDED',
                isVideo: true,
              };
            }
          }
        }
      }
    }

    if (!session) {
      throw new BusinessException(
        ERROR_CODES.NOT_FOUND,
        'Live session not found',
        HttpStatus.NOT_FOUND,
      );
    }

    const windowEnd = session.endedAt ?? (
      session.status === 'LIVE'
        ? new Date()
        : new Date(session.startedAt.getTime() + (session.durationSeconds || 0) * 1000)
    );
    const isVideo = session.isVideo || false;

    // 1. Fetch Room Info
    let roomName: string | null = null;
    let roomImageUrl: string | null = null;
    let roomType: 'VIDEO' | 'AUDIO' = isVideo ? 'VIDEO' : 'AUDIO';

    if (isVideo && this.prisma) {
      const vRoom = await this.prisma.videoRoom.findUnique({
        where: { id: session.roomId },
      }).catch(() => null);
      if (vRoom) {
        roomName = (session as any).name || vRoom.name;
        const targetImageKey = (session as any).imageKey || vRoom.imageKey;
        roomImageUrl = this.media && targetImageKey
          ? await this.media.resolve(targetImageKey).catch(() => null)
          : null;
      }
    } else {
      const aRoom = await this.rooms.getRoom(session.roomId).catch(() => null);
      if (aRoom) {
        roomName = aRoom.name;
        roomImageUrl = aRoom.imageUrl;
        roomType = 'AUDIO';
      }
    }

    // 2. Fetch Gift Transactions strictly within this room's context and [session.startedAt, windowEnd]
    let giftTxns: any[] = [];
    if (this.prisma) {
      giftTxns = await this.prisma.giftTransaction.findMany({
        where: {
          status: 'COMPLETED',
          contextId: session.roomId,
          contextType: isVideo ? 'VIDEO_ROOM' : 'AUDIO_ROOM',
          createdAt: {
            gte: session.startedAt,
            lte: windowEnd,
          },
        },
        orderBy: { createdAt: 'desc' },
      }).catch(() => []);
    }

    const totalGiftsCount = giftTxns.reduce((acc, t) => acc + (t.quantity || 1), 0);
    const giftValueCoins = giftTxns.reduce((acc, t) => acc + Number(t.totalCoinValue || 0), 0);
    const creatorEarnings = giftTxns.reduce(
      (acc, t) => acc + Number(t.creatorEarnings ?? t.totalCoinValue ?? 0),
      0,
    );
    const uniqueGiftersCount = new Set(giftTxns.map((t) => t.senderId)).size;

    // Top Gifters aggregation
    const senderCoinsMap = new Map<string, number>();
    for (const t of giftTxns) {
      senderCoinsMap.set(
        t.senderId,
        (senderCoinsMap.get(t.senderId) || 0) + Number(t.totalCoinValue || 0),
      );
    }
    const sortedSenders = Array.from(senderCoinsMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const topSenderIds = sortedSenders.map(([id]) => id);
    const senderUsers = this.prisma && topSenderIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: topSenderIds } },
          select: { id: true, username: true, fullName: true },
        }).catch(() => [])
      : [];
    const senderProfiles = this.prisma && topSenderIds.length > 0
      ? await this.prisma.userProfile.findMany({
          where: { userId: { in: topSenderIds } },
          select: { userId: true, avatarKey: true },
        }).catch(() => [])
      : [];
    const senderProfileMap = new Map(senderProfiles.map((p) => [p.userId, p]));
    const senderUserMap = new Map(senderUsers.map((u) => [u.id, u]));

    const topGifters: LiveHistoryTopGifterView[] = await Promise.all(
      sortedSenders.map(async ([senderId, coins], idx) => {
        const u = senderUserMap.get(senderId);
        const p = senderProfileMap.get(senderId);
        const avatarUrl = this.media && p?.avatarKey
          ? await this.media.resolve(p.avatarKey).catch(() => null)
          : null;
        return {
          userId: senderId,
          username: u?.username || 'user',
          name: u?.fullName || u?.username || 'User',
          avatarUrl,
          rank: idx + 1,
          coins,
        };
      }),
    );

    // Gift Breakdown aggregation
    const giftMap = new Map<string, { quantity: number; coins: number }>();
    for (const t of giftTxns) {
      const cur = giftMap.get(t.giftId) || { quantity: 0, coins: 0 };
      cur.quantity += t.quantity || 1;
      cur.coins += Number(t.totalCoinValue || 0);
      giftMap.set(t.giftId, cur);
    }
    const giftIds = Array.from(giftMap.keys());
    const catalogGifts = this.prisma && giftIds.length > 0
      ? await this.prisma.gift.findMany({
          where: { id: { in: giftIds } },
          select: { id: true, name: true, displayName: true, thumbnailUrl: true, animationUrl: true },
        }).catch(() => [])
      : [];
    const catalogMap = new Map(catalogGifts.map((g) => [g.id, g]));

    const giftBreakdown: LiveHistoryGiftBreakdownView[] = Array.from(giftMap.entries())
      .map(([giftId, data]) => {
        const g = catalogMap.get(giftId);
        return {
          giftId,
          name: g?.displayName || g?.name || 'Gift',
          iconUrl: g?.thumbnailUrl || g?.animationUrl || null,
          quantity: data.quantity,
          coins: data.coins,
        };
      })
      .sort((a, b) => b.coins - a.coins);

    // 3. Fetch Viewers Analytics
    const [visitorRows, newFollowers, videoStats] = await Promise.all([
      this.analytics.getVisitorsInRange(session.roomId, session.startedAt, windowEnd).catch(() => []),
      this.social.countNewFollowers(userId, session.startedAt, windowEnd).catch(() => 0),
      isVideo && this.prisma
        ? this.prisma.videoRoomStatistics.findUnique({ where: { roomId: session.roomId } }).catch(() => null)
        : Promise.resolve(null),
    ]);

    let visits = visitorRows.length;
    let uniqueViewers = visitorRows.length > 0
      ? new Set(visitorRows.map((v) => v.userId)).size
      : 0;
    let peak = peakConcurrent(visitorRows, session.startedAt, windowEnd);

    if (this.prisma) {
      if (isVideo) {
        const sessionMembers = await this.prisma.videoRoomMember.findMany({
          where: {
            roomId: session.roomId,
            OR: [
              { joinedAt: { gte: session.startedAt, lte: windowEnd } },
              {
                joinedAt: { lte: windowEnd },
                OR: [
                  { leftAt: null },
                  { leftAt: { gte: session.startedAt } },
                ],
              },
            ],
          },
          select: { userId: true },
        }).catch(() => []);

        const activePresences = session.status === 'LIVE'
          ? await this.prisma.videoRoomPresence.count({ where: { roomId: session.roomId } }).catch(() => 0)
          : 0;

        const timeScopedCount = sessionMembers.length;
        const timeScopedUnique = new Set(sessionMembers.map((m) => m.userId)).size;

        visits = Math.max(visits, timeScopedCount, activePresences);
        uniqueViewers = Math.max(uniqueViewers, timeScopedUnique, activePresences);
        peak = Math.max(peak, activePresences, uniqueViewers);
      } else {
        const sessionAudioMembers = await this.prisma.roomMember.findMany({
          where: {
            roomId: session.roomId,
            OR: [
              { joinedAt: { gte: session.startedAt, lte: windowEnd } },
              {
                joinedAt: { lte: windowEnd },
                OR: [
                  { leftAt: null },
                  { leftAt: { gte: session.startedAt } },
                ],
              },
            ],
          },
          select: { userId: true },
        }).catch(() => []);

        const timeScopedCount = sessionAudioMembers.length;
        const timeScopedUnique = new Set(sessionAudioMembers.map((m) => m.userId)).size;

        visits = Math.max(visits, timeScopedCount);
        uniqueViewers = Math.max(uniqueViewers, timeScopedUnique);
        peak = Math.max(peak, uniqueViewers);
      }
    }

    const durationSeconds = session.status === 'LIVE'
      ? Math.max(0, Math.floor((Date.now() - session.startedAt.getTime()) / 1000))
      : (session.durationSeconds ?? (session.endedAt ? Math.max(0, Math.floor((session.endedAt.getTime() - session.startedAt.getTime()) / 1000)) : 0));

    const avgViewers = peak > 0 ? Math.max(1, Math.round((uniqueViewers + peak) / 2)) : uniqueViewers;

    return {
      session: {
        sessionId: session.id,
        roomId: session.roomId,
        roomName,
        roomImageUrl,
        roomType,
        status: session.status,
        endReason: 'HOST_ENDED',
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationSeconds,
        paidEntryEnabled: (session as any).paidEntryEnabled ?? false,
        entryFee: (session as any).entryFee ?? 0,
        paidEntrants: (session as any).paidEntrants ?? 0,
        entryRevenue: (session as any).entryRevenue ?? 0,
        entryCreatorEarnings: (session as any).entryCreatorEarnings ?? 0,
      },
      viewerAnalytics: {
        totalUniqueViewers: uniqueViewers,
        peakConcurrentViewers: peak,
        avgViewers,
        totalVisits: visits,
        newFollowers,
        totalLikes: 0,
      },
      giftAnalytics: {
        totalGifts: totalGiftsCount,
        giftValueCoins,
        uniqueGifters: uniqueGiftersCount,
        creatorEarnings,
        topGifters,
        giftBreakdown,
      },
    };
  }

  getPkHistory(userId: string, page: number, limit: number, skip: number, filter: PkHistoryFilter) {
    return this.pk.historyForCreator(userId, { skip, limit, page, filter });
  }

  async getPkHistoryDetail(userId: string, battleId: string) {
    const detail = await this.pk.getCreatorBattleDetail(userId, battleId);
    if (!detail) {
      throw new BusinessException(
        ERROR_CODES.NOT_FOUND,
        'PK battle not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return detail;
  }

  private async enrichSessions(
    userId: string,
    sessions: (LiveSessionView & { isVideo?: boolean })[],
  ): Promise<LiveHistoryEntryView[]> {
    if (sessions.length === 0) return [];

    const roomCache = new Map<string, (RoomView & { roomType?: 'VIDEO' | 'AUDIO' }) | null>();
    const roomFor = async (roomId: string): Promise<(RoomView & { roomType?: 'VIDEO' | 'AUDIO' }) | null> => {
      if (!roomCache.has(roomId)) {
        const r = await this.rooms.getRoom(roomId).catch(() => null);
        if (r) {
          roomCache.set(roomId, { ...r, roomType: 'AUDIO' });
        } else if (this.prisma) {
          const vRoom = await this.prisma.videoRoom.findUnique({
            where: { id: roomId },
          }).catch(() => null);
          if (vRoom) {
            const resolvedImageUrl = this.media
              ? await this.media.resolve(vRoom.imageKey).catch(() => null)
              : vRoom.imageKey;
            roomCache.set(roomId, {
              id: vRoom.id,
              name: vRoom.name,
              imageUrl: resolvedImageUrl || null,
              ownerId: vRoom.ownerId,
              roomType: 'VIDEO',
            } as any);
          } else {
            roomCache.set(roomId, null);
          }
        } else {
          roomCache.set(roomId, null);
        }
      }
      return roomCache.get(roomId) ?? null;
    };

    return Promise.all(
      sessions.map(async (session) => {
        const windowEnd = session.endedAt ?? (
          session.status === 'LIVE'
            ? new Date()
            : new Date(session.startedAt.getTime() + (session.durationSeconds || 0) * 1000)
        );
        const room = await roomFor(session.roomId);
        const isVideo = session.isVideo || room?.roomType === 'VIDEO';

        const [visitorRows, giftCoinsAmount, newFollowers, videoStats] = await Promise.all([
          this.analytics.getVisitorsInRange(session.roomId, session.startedAt, windowEnd).catch(() => []),
          isVideo
            ? this.gifts
                .getContextCoinsInRange(GiftContextType.VIDEO_ROOM, session.roomId, session.startedAt, windowEnd)
                .catch(() => 0n)
            : this.gifts
                .getContextCoinsInRange(GiftContextType.AUDIO_ROOM, session.roomId, session.startedAt, windowEnd)
                .catch(() => 0n),
          this.social.countNewFollowers(userId, session.startedAt, windowEnd).catch(() => 0),
          isVideo && this.prisma
            ? this.prisma.videoRoomStatistics.findUnique({ where: { roomId: session.roomId } }).catch(() => null)
            : Promise.resolve(null),
        ]);

        let effectiveCoins = giftCoinsAmount;
        let totalGiftsCount = 0;
        let creatorEarningsVal = 0;

        if (this.prisma) {
          const directGifts = await this.prisma.giftTransaction.aggregate({
            where: {
              status: 'COMPLETED',
              contextId: session.roomId,
              contextType: isVideo ? 'VIDEO_ROOM' : 'AUDIO_ROOM',
              createdAt: {
                gte: session.startedAt,
                lte: windowEnd,
              },
            },
            _sum: { totalCoinValue: true, quantity: true, creatorEarnings: true },
          }).catch(() => null);

          if (directGifts?._sum?.totalCoinValue) {
            effectiveCoins = directGifts._sum.totalCoinValue;
          } else {
            effectiveCoins = 0n;
          }
          totalGiftsCount = directGifts?._sum?.quantity || 0;
          creatorEarningsVal = Number(directGifts?._sum?.creatorEarnings || effectiveCoins);
        }

        const totalCoins = effectiveCoins.toString();
        const giftValueNum = Number(effectiveCoins);
        let visitorsCount = visitorRows.length;
        let uniqueVisitorsCount = visitorRows.length > 0
          ? new Set(visitorRows.map((v) => v.userId)).size
          : 0;
        let peak = peakConcurrent(visitorRows, session.startedAt, windowEnd);

        if (this.prisma) {
          if (isVideo) {
            const sessionMembers = await this.prisma.videoRoomMember.findMany({
              where: {
                roomId: session.roomId,
                OR: [
                  { joinedAt: { gte: session.startedAt, lte: windowEnd } },
                  {
                    joinedAt: { lte: windowEnd },
                    OR: [
                      { leftAt: null },
                      { leftAt: { gte: session.startedAt } },
                    ],
                  },
                ],
              },
              select: { userId: true },
            }).catch(() => []);

            const activePresences = session.status === 'LIVE'
              ? await this.prisma.videoRoomPresence.count({ where: { roomId: session.roomId } }).catch(() => 0)
              : 0;

            const timeScopedCount = sessionMembers.length;
            const timeScopedUnique = new Set(sessionMembers.map((m) => m.userId)).size;

            visitorsCount = Math.max(visitorsCount, timeScopedCount, activePresences);
            uniqueVisitorsCount = Math.max(uniqueVisitorsCount, timeScopedUnique, activePresences);
            peak = Math.max(peak, activePresences, uniqueVisitorsCount);
          } else {
            const sessionAudioMembers = await this.prisma.roomMember.findMany({
              where: {
                roomId: session.roomId,
                OR: [
                  { joinedAt: { gte: session.startedAt, lte: windowEnd } },
                  {
                    joinedAt: { lte: windowEnd },
                    OR: [
                      { leftAt: null },
                      { leftAt: { gte: session.startedAt } },
                    ],
                  },
                ],
              },
              select: { userId: true },
            }).catch(() => []);

            const timeScopedCount = sessionAudioMembers.length;
            const timeScopedUnique = new Set(sessionAudioMembers.map((m) => m.userId)).size;

            visitorsCount = Math.max(visitorsCount, timeScopedCount);
            uniqueVisitorsCount = Math.max(uniqueVisitorsCount, timeScopedUnique);
            peak = Math.max(peak, uniqueVisitorsCount);
          }
        }

        const durationSeconds = session.status === 'LIVE'
          ? Math.max(0, Math.floor((Date.now() - session.startedAt.getTime()) / 1000))
          : (session.durationSeconds ?? (session.endedAt ? Math.max(0, Math.floor((session.endedAt.getTime() - session.startedAt.getTime()) / 1000)) : 0));

        const sessionName = (session as any).name || room?.name || null;
        let sessionImageUrl = room?.imageUrl ?? null;
        if ((session as any).imageKey && this.media) {
          sessionImageUrl = (await this.media.resolve((session as any).imageKey).catch(() => null)) || sessionImageUrl;
        }

        let entryFeeVal = 0;
        let paidEntrantsVal = 0;
        let entryRevenueVal = 0;
        let entryCreatorEarningsVal = 0;

        if (isVideo && this.prisma) {
          const bsRow = await (this.prisma as any).videoBroadcastSession.findUnique({
            where: { id: session.id },
            select: {
              entryFee: true,
              totalPaidEntrants: true,
              totalEntryRevenue: true,
              entryCreatorEarnings: true,
            },
          }).catch(() => null);

          if (bsRow) {
            entryFeeVal = bsRow.entryFee ? Number(bsRow.entryFee) : 0;
            paidEntrantsVal = bsRow.totalPaidEntrants ?? 0;
            entryRevenueVal = bsRow.totalEntryRevenue ? Number(bsRow.totalEntryRevenue) : 0;
            entryCreatorEarningsVal = bsRow.entryCreatorEarnings ? Number(bsRow.entryCreatorEarnings) : 0;
          }
        }

        return {
          sessionId: session.id,
          roomId: session.roomId,
          roomName: sessionName,
          roomImageUrl: sessionImageUrl,
          roomType: (isVideo ? 'VIDEO' : 'AUDIO') as 'VIDEO' | 'AUDIO',
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          durationSeconds,
          status: session.status,
          endReason: 'HOST_ENDED',
          visitors: visitorsCount,
          uniqueVisitors: uniqueVisitorsCount,
          peakParticipants: peak,
          totalGifts: totalGiftsCount,
          giftValue: giftValueNum,
          creatorEarnings: creatorEarningsVal,
          giftCoins: totalCoins,
          newFollowers,
          entryFee: entryFeeVal,
          paidEntrants: paidEntrantsVal,
          entryRevenue: entryRevenueVal,
          entryCreatorEarnings: entryCreatorEarningsVal,
        };
      }),
    );
  }
}
