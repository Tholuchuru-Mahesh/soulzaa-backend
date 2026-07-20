import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformRole, VideoRoom } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated, normalizePagination } from 'src/common/utils/pagination.util';
import { loadVideoRoomConfig } from '../config/video-room.config';
import type { VideoRoomDetailView, VideoRoomStatusView } from '../entities/video-room-detail.view';
import type { VideoRoomView } from '../entities/video-room.view';
import type { ListVideoRoomsDto } from '../dto/list-video-rooms.dto';
import type { SearchVideoRoomsDto } from '../dto/search-video-rooms.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { toVideoRoomDetailView, toVideoRoomStatusView } from '../mappers/video-room-detail.mapper';
import { toVideoRoomView } from '../mappers/video-room.mapper';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';

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
  ) {
    this.cacheTtlSeconds = loadVideoRoomConfig(config).cacheTtlSeconds;
  }

  /** Full room detail (cache-first). Throws VIDEO_ROOM_NOT_FOUND (404) if missing. */
  async getDetail(roomId: string): Promise<VideoRoomDetailView> {
    const cached = await this.repo.getCachedSnapshot<VideoRoomDetailView>(roomId);
    if (cached) return cached;

    const detail = await this.repo.findDetail(roomId);
    if (!detail) throw this.notFound(roomId);

    const view = toVideoRoomDetailView(detail);
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
    return this.paginateViews(items, total, page, limit);
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
    return this.paginateViews(items, total, page, limit);
  }

  /** "Popular" — ranked by denormalised statistics (peak viewers, then joins). */
  async popular(query: ListVideoRoomsDto, actor: RoomActor): Promise<Paginated<VideoRoomView>> {
    const { page, limit, skip } = normalizePagination(query);
    const { items, total } = await this.repo.popular({
      skip,
      take: limit,
      discoverableOnly: !this.isPrivileged(actor),
    });
    return this.paginateViews(items, total, page, limit);
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
    return this.paginateViews(items, total, page, limit);
  }

  /** "Trending" — hydrate the global trending zset (highest first). */
  async trending(limit: number): Promise<VideoRoomView[]> {
    const ids = await this.repo.trendingTopIds(limit);
    if (ids.length === 0) return [];
    const rooms = await this.repo.findManyByIds(ids);
    return rooms.map(toVideoRoomView);
  }

  /** The caller's own rooms (any status, non-deleted). */
  async mine(actor: RoomActor): Promise<VideoRoomView[]> {
    const rooms = await this.repo.findByOwnerId(actor.id);
    return rooms.map(toVideoRoomView);
  }

  private paginateViews(
    rooms: VideoRoom[],
    total: number,
    page: number,
    limit: number,
  ): Paginated<VideoRoomView> {
    return buildPaginated(rooms.map(toVideoRoomView), total, page, limit);
  }

  private isPrivileged(actor: RoomActor): boolean {
    return (
      actor.roles.includes(PlatformRole.ADMIN) || actor.roles.includes(PlatformRole.SUPER_ADMIN)
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
