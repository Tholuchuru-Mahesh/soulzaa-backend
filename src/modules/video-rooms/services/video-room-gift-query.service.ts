import { HttpStatus, Injectable } from '@nestjs/common';
import { GiftContextType, Prisma, type GiftTransaction } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { GiftRepository } from 'src/modules/gifts/repositories/gift.repository';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { VideoRoomGiftHistoryDto } from '../dto/video-room-gift-query.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';
import {
  VideoRoomGiftComboService,
  type VideoRoomGiftComboView,
} from './video-room-gift-combo.service';
import {
  VideoRoomGiftStatisticsService,
  type VideoRoomGiftBreakdown,
  type VideoRoomGiftSummary,
  type VideoRoomRecentGift,
} from './video-room-gift-statistics.service';

/** Client-safe projection of a ledger row. */
export interface VideoRoomGiftHistoryEntry {
  transactionId: string;
  batchId: string | null;
  senderId: string;
  receiverId: string;
  giftId: string;
  giftType: string;
  quantity: number;
  comboTier: number;
  coinValue: number;
  receiverEarnings: number;
  isLuckyWin: boolean;
  luckyMultiplier: number;
  status: string;
  createdAt: Date;
}

/**
 * Read side of the video-room gift engine (VR-10).
 *
 * History comes from the shared `gift_transactions` ledger scoped to this room —
 * the `[contextType, contextId, createdAt]` index serves it directly, so no
 * per-room rollup table exists to drift out of sync. Recent and combo reads are
 * Redis-only and intentionally never fall back to Postgres: both are live views
 * whose absence on a cold cache is correct, not an error.
 */
@Injectable()
export class VideoRoomGiftQueryService {
  constructor(
    private readonly gifts: GiftRepository,
    private readonly combo: VideoRoomGiftComboService,
    private readonly statistics: VideoRoomGiftStatisticsService,
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
  ) {}

  /** Paginated gift ledger for a room. */
  async history(
    roomId: string,
    query: VideoRoomGiftHistoryDto,
  ): Promise<Paginated<VideoRoomGiftHistoryEntry>> {
    const where: Prisma.GiftTransactionWhereInput = {
      contextType: GiftContextType.VIDEO_ROOM,
      contextId: roomId,
      ...(query.senderId ? { senderId: query.senderId } : {}),
      ...(query.receiverId ? { receiverId: query.receiverId } : {}),
      ...(query.giftId ? { giftId: query.giftId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.gifts.listTransactions(where, query.skip, query.limit);
    return buildPaginated(
      rows.map((row) => this.toEntry(row)),
      total,
      query.page,
      query.limit,
    );
  }

  /** Newest-first live feed, straight from Redis. */
  recent(roomId: string): Promise<VideoRoomRecentGift[]> {
    return this.statistics.recent(roomId);
  }

  /** Live combos for this room; empty on a cold cache, which is correct. */
  combos(roomId: string): Promise<VideoRoomGiftComboView[]> {
    return this.combo.listActive(roomId);
  }

  /**
   * Statistics scaled to what the caller may see: every member gets the summary;
   * VIEW_ANALYTICS holders additionally get the per-user breakdown. The check
   * lives here rather than in the controller, matching how every other
   * video-room service owns its own authorization.
   */
  async statisticsFor(
    roomId: string,
    actor: RoomActor,
  ): Promise<VideoRoomGiftSummary | VideoRoomGiftBreakdown> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const canViewAnalytics = await this.permissions.hasPermission(
      actor,
      { id: room.id, ownerId: room.ownerId },
      VideoRoomPermission.VIEW_ANALYTICS,
    );
    return canViewAnalytics ? this.statistics.breakdown(roomId) : this.statistics.summary(roomId);
  }

  private toEntry(row: GiftTransaction): VideoRoomGiftHistoryEntry {
    const metadata = row.metadata as { batchId?: string } | null;
    return {
      transactionId: row.id,
      batchId: metadata?.batchId ?? null,
      senderId: row.senderId,
      receiverId: row.receiverId,
      giftId: row.giftId,
      giftType: row.giftType,
      quantity: row.quantity,
      comboTier: row.comboTier,
      coinValue: Number(row.totalCoinValue),
      receiverEarnings: Number(row.creatorEarnings),
      isLuckyWin: row.isLuckyWin,
      luckyMultiplier: row.luckyMultiplier,
      status: row.status,
      createdAt: row.createdAt,
    };
  }
}
