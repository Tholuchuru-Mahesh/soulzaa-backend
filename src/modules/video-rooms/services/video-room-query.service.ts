import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformRole, VideoRoom, VideoRoomStatus } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated, normalizePagination } from 'src/common/utils/pagination.util';
import { GIFTS_SERVICE, type IGiftsService } from 'src/modules/gifts/interfaces/gifts.service.interface';
import { loadVideoRoomConfig } from '../config/video-room.config';
import type { VideoRoomDetailView, VideoRoomStatusView } from '../entities/video-room-detail.view';
import type { VideoRoomView } from '../entities/video-room.view';
import type { ListVideoRoomsDto } from '../dto/list-video-rooms.dto';
import type { SearchVideoRoomsDto } from '../dto/search-video-rooms.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import {
  resolveRequiredEntryGift,
  toVideoRoomDetailView,
  toVideoRoomStatusView,
} from '../mappers/video-room-detail.mapper';
import { toVideoRoomView } from '../mappers/video-room.mapper';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPresenceService } from './video-room-presence.service';

/**
 * The read side of the video-room lifecycle (VR-2, CQRS-ready). Pure queries — no
 * mutation. Detail reads are cache-first (the write side invalidates on change);
 * discovery is role-scoped (non-privileged callers see only discoverable rooms).
 * Discovery ranks on durable signals now (newest / verified / statistics / trending
 * seed); friends/following and live-signal ranking land with the join/social phases.
 */
@Injectable()
export class VideoRoomQueryService {
  private readonly cacheTtlSeconds: number;

  constructor(
    private readonly repo: VideoRoomsRepository,
    config: ConfigService,
    @Inject(GIFTS_SERVICE) private readonly gifts: IGiftsService,
    @Optional() private readonly presence?: VideoRoomPresenceService,
  ) {
    this.cacheTtlSeconds = loadVideoRoomConfig(config).cacheTtlSeconds;
  }

  /** Full room detail (cache-first). Throws VIDEO_ROOM_NOT_FOUND (404) if missing. */
  async getDetail(roomId: string): Promise<VideoRoomDetailView> {
    const cached = await this.repo.getCachedSnapshot<VideoRoomDetailView>(roomId);
    if (cached) {
      if (cached.status === VideoRoomStatus.LIVE && this.presence) {
        try {
          const liveCount = await this.presence.viewerCount(roomId);
          cached.spectatorCount = liveCount;
          cached.activeViewers = liveCount;
          cached.participantCount = liveCount;
        } catch {}
      }
      return cached;
    }

    const detail = await this.repo.findDetail(roomId);
    if (!detail) throw this.notFound(roomId);

    let spectatorCount = 0;
    if (detail.room.status === VideoRoomStatus.LIVE) {
      try {
        const [redisCount, dbCount] = await Promise.all([
          this.presence ? this.presence.viewerCount(roomId) : 0,
          this.repo.countActiveMembers(roomId),
        ]);
        spectatorCount = Math.max(redisCount, dbCount);
      } catch {}
    }

    const requiredEntryGift = await resolveRequiredEntryGift(this.gifts, detail.room as any);
    const view = toVideoRoomDetailView(detail, { requiredEntryGift, spectatorCount });
    await this.repo.setCachedSnapshot(roomId, view, this.cacheTtlSeconds);
    return view;
  }

  /** "Verify room status" — the lifecycle projection, including soft-deleted rooms. */
  async verifyStatus(roomId: string): Promise<VideoRoomStatusView> {
    const room = await this.repo.findAnyById(roomId);
    if (!room) throw this.notFound(roomId);
    return toVideoRoomStatusView(room);
  }

  /** Newest-first discovery listing (role-scoped). */
  async list(query: ListVideoRoomsDto, actor: RoomActor): Promise<Paginated<VideoRoomView>> {
    const { page, limit, skip } = normalizePagination(query);
    const { items, total } = await this.repo.list({
      skip,
      take: limit,
      discoverableOnly: !this.isPrivileged(actor),
      status: query.status,
    });
    return await this.paginateViews(items, total, page, limit);
  }

  /** Faceted search (category / language / country / tags / access policy). */
  async search(query: SearchVideoRoomsDto, actor: RoomActor): Promise<Paginated<VideoRoomView>> {
    const { page, limit, skip } = normalizePagination(query);
    const { items, total } = await this.repo.search({
      skip,
      take: limit,
      discoverableOnly: !this.isPrivileged(actor),
      status: query.status,
      categoryId: query.categoryId,
      language: query.language,
      country: query.country,
      tags: query.tags,
      accessPolicy: query.accessPolicy,
    });
    return await this.paginateViews(items, total, page, limit);
  }

  /** "Popular" — ranked by denormalised statistics (peak viewers, then joins). */
  async popular(query: ListVideoRoomsDto, actor: RoomActor): Promise<Paginated<VideoRoomView>> {
    const { page, limit, skip } = normalizePagination(query);
    const { items, total } = await this.repo.popular({
      skip,
      take: limit,
      discoverableOnly: !this.isPrivileged(actor),
    });
    return await this.paginateViews(items, total, page, limit);
  }

  /** "Featured" — verified rooms only. */
  async featured(query: ListVideoRoomsDto, actor: RoomActor): Promise<Paginated<VideoRoomView>> {
    const { page, limit, skip } = normalizePagination(query);
    const { items, total } = await this.repo.search({
      skip,
      take: limit,
      discoverableOnly: !this.isPrivileged(actor),
      isVerified: true,
    });
    return await this.paginateViews(items, total, page, limit);
  }

  /** "Trending" — hydrate the global trending zset (highest first). */

  async trending(limit: number): Promise<VideoRoomView[]> {
    const ids = await this.repo.trendingTopIds(limit);
    if (ids.length === 0) return [];
    const rooms = await this.repo.findLiveRoomsByIds(ids);
    const liveCounts = await this.resolveLiveCounts(rooms);
    const prisma = (this.repo as any).prisma;
    if (!prisma) {
      return rooms.map((room) =>
        toVideoRoomView(room, 0, undefined, undefined, liveCounts.get(room.id) ?? 0),
      );
    }
    const sums = await prisma.giftTransaction.groupBy({
      by: ['contextId'],
      _sum: { totalCoinValue: true },
      where: { contextId: { in: ids } },
    });
    const sumMap = new Map<string, number>(
      sums.map((s: any) => [s.contextId, Number(s._sum.totalCoinValue || 0)]),
    );
    const ownerIds = rooms.map((r) => r.ownerId);
    const owners = await prisma.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, username: true, fullName: true },
    });
    const ownerMap = new Map<string, string>(
      owners.map((o: any) => [o.id, o.fullName || o.username]),
    );
    return rooms.map((room) =>
      toVideoRoomView(
        room,
        sumMap.get(room.id) || 0,
        ownerMap.get(room.ownerId),
        undefined,
        liveCounts.get(room.id) ?? 0,
      ),
    );
  }

  /** The caller's own rooms (any status, non-deleted). */
  async mine(actor: RoomActor): Promise<VideoRoomView[]> {
    const rooms = await this.repo.findByOwnerId(actor.id);
    const ids = rooms.map((r) => r.id);
    const liveCounts = await this.resolveLiveCounts(rooms);
    const prisma = (this.repo as any).prisma;
    if (!prisma) {
      return rooms.map((room) =>
        toVideoRoomView(room, 0, undefined, undefined, liveCounts.get(room.id) ?? 0),
      );
    }
    const sums = await prisma.giftTransaction.groupBy({
      by: ['contextId'],
      _sum: { totalCoinValue: true },
      where: { contextId: { in: ids } },
    });
    const sumMap = new Map<string, number>(
      sums.map((s: any) => [s.contextId, Number(s._sum.totalCoinValue || 0)]),
    );
    const ownerIds = rooms.map((r) => r.ownerId);
    const owners = await prisma.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, username: true, fullName: true },
    });
    const ownerMap = new Map<string, string>(
      owners.map((o: any) => [o.id, o.fullName || o.username]),
    );
    return rooms.map((room) =>
      toVideoRoomView(
        room,
        sumMap.get(room.id) || 0,
        ownerMap.get(room.ownerId),
        undefined,
        liveCounts.get(room.id) ?? 0,
      ),
    );
  }

  private async resolveLiveCounts(rooms: VideoRoom[]): Promise<Map<string, number>> {
    const liveRooms = rooms.filter((r) => r.status === VideoRoomStatus.LIVE);
    if (liveRooms.length === 0) return new Map();

    const counts = await Promise.all(
      liveRooms.map(async (r) => {
        try {
          const [redisCount, dbCount] = await Promise.all([
            this.presence ? this.presence.viewerCount(r.id) : 0,
            this.repo.countActiveMembers(r.id),
          ]);
          return [r.id, Math.max(redisCount, dbCount)] as const;
        } catch {
          return [r.id, 0] as const;
        }
      }),
    );
    return new Map(counts);
  }

  private async paginateViews(
    rooms: VideoRoom[],
    total: number,
    page: number,
    limit: number,
  ): Promise<Paginated<VideoRoomView>> {
    const roomIds = rooms.map((r) => r.id);
    const liveCounts = await this.resolveLiveCounts(rooms);
    const prisma = (this.repo as any).prisma;
    if (!prisma) {
      const mapped = rooms.map((room) =>
        toVideoRoomView(room, 0, undefined, undefined, liveCounts.get(room.id) ?? 0),
      );
      return buildPaginated(mapped, total, page, limit);
    }
    const sums = await prisma.giftTransaction.groupBy({
      by: ['contextId'],
      _sum: { totalCoinValue: true },
      where: { contextId: { in: roomIds } },
    });
    const sumMap = new Map<string, number>(
      sums.map((s: any) => [s.contextId, Number(s._sum.totalCoinValue || 0)]),
    );
    const ownerIds = rooms.map((r) => r.ownerId);
    const owners = await prisma.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, username: true, fullName: true },
    });
    const ownerMap = new Map<string, string>(
      owners.map((o: any) => [o.id, o.fullName || o.username]),
    );
    const mapped = rooms.map((room) =>
      toVideoRoomView(
        room,
        sumMap.get(room.id) || 0,
        ownerMap.get(room.ownerId),
        undefined,
        liveCounts.get(room.id) ?? 0,
      ),
    );
    return buildPaginated(mapped, total, page, limit);
  }

  private isPrivileged(actor: RoomActor): boolean {
    return (
      actor.roles.includes(PlatformRole.ADMIN) ||
      actor.roles.includes(PlatformRole.SUPER_ADMIN) ||
      actor.roles.includes(PlatformRole.MODERATOR)
    );
  }

  private notFound(roomId: string): BusinessException {
    return new BusinessException(
      ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
      `Video room ${roomId} was not found.`,
      HttpStatus.NOT_FOUND,
    );
  }
}
