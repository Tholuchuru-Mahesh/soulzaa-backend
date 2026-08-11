import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
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
import { SOCIAL_SERVICE, type ISocialService } from 'src/modules/social/interfaces/social.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { WithdrawalApprovalService } from 'src/modules/withdrawals/services/withdrawal-approval.service';
import { WithdrawalConfigurationService } from 'src/modules/withdrawals/services/withdrawal-configuration.service';
import { WithdrawalHistoryService } from 'src/modules/withdrawals/services/withdrawal-history.service';
import { WithdrawalService } from 'src/modules/withdrawals/services/withdrawal.service';
import type { LiveHistoryEntryView } from '../interfaces/live-history.interface';
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
  ): Promise<Paginated<LiveHistoryEntryView>> {
    const { rows, total } = await this.rooms.listMyLiveSessions(userId, skip, limit);
    const items = await this.enrichSessions(userId, rows);
    return buildPaginated(items, total, page, limit);
  }

  async getLiveHistoryDetail(userId: string, sessionId: string): Promise<LiveHistoryEntryView> {
    const session = await this.rooms.getMyLiveSession(userId, sessionId);
    if (!session) {
      throw new BusinessException(
        ERROR_CODES.NOT_FOUND,
        'Live session not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const [entry] = await this.enrichSessions(userId, [session]);
    return entry;
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
    sessions: LiveSessionView[],
  ): Promise<LiveHistoryEntryView[]> {
    if (sessions.length === 0) return [];

    const roomCache = new Map<string, RoomView | null>();
    const roomFor = async (roomId: string): Promise<RoomView | null> => {
      if (!roomCache.has(roomId)) {
        roomCache.set(roomId, await this.rooms.getRoom(roomId));
      }
      return roomCache.get(roomId) ?? null;
    };

    return Promise.all(
      sessions.map(async (session) => {
        const windowEnd = session.endedAt ?? new Date();
        const [room, visitorRows, giftCoins, newFollowers] = await Promise.all([
          roomFor(session.roomId),
          this.analytics.getVisitorsInRange(session.roomId, session.startedAt, windowEnd),
          this.gifts.getContextCoinsInRange(
            GiftContextType.AUDIO_ROOM,
            session.roomId,
            session.startedAt,
            windowEnd,
          ),
          this.social.countNewFollowers(userId, session.startedAt, windowEnd),
        ]);

        return {
          sessionId: session.id,
          roomId: session.roomId,
          roomName: room?.name ?? null,
          roomImageUrl: room?.imageUrl ?? null,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          durationSeconds: session.durationSeconds,
          status: session.status,
          visitors: visitorRows.length,
          uniqueVisitors: new Set(visitorRows.map((v) => v.userId)).size,
          peakParticipants: peakConcurrent(visitorRows, session.startedAt, windowEnd),
          giftCoins: giftCoins.toString(),
          newFollowers,
        };
      }),
    );
  }
}
