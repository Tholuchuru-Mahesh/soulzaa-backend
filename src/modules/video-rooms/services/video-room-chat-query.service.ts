import { Injectable } from '@nestjs/common';
import { VideoRoomMessageType } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { toChatMessagePayload } from '../dto/chat/chat-message.mapper';
import type { ChatMessagePayload } from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { ELEVATED_VIDEO_ROOM_ROLES } from '../constants/video-room-permissions';
import { VideoRoomChatRepository } from '../repositories/video-room-chat.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';
import { VideoRoomChatPolicyService } from './video-room-chat-policy.service';
import { VideoRoomPermissionService } from './video-room-permission.service';

export interface HistoryQuery {
  page: number;
  limit: number;
  skip: number;
  before?: string;
  order?: 'asc' | 'desc';
}

export interface SearchQuery {
  page: number;
  limit: number;
  skip: number;
  q?: string;
  senderId?: string;
  type?: VideoRoomMessageType;
  from?: Date;
  to?: Date;
  pinnedOnly?: boolean;
  announcementsOnly?: boolean;
}

/**
 * The read side of VR-9 chat (CQRS-ready split, mirroring VR-2's
 * lifecycle/query separation).
 *
 * The Redis ring buffer is consulted ONLY for the natural hot path: page 1,
 * newest-first, no keyset cursor. That is the request 10k viewers all issue when
 * they join a live room, and serving it from memory is the entire point. Deep
 * pages and keyset reads go to Postgres, where the composite indexes live.
 */
@Injectable()
export class VideoRoomChatQueryService {
  constructor(
    private readonly repo: VideoRoomChatRepository,
    private readonly cache: VideoRoomChatCacheService,
    private readonly policy: VideoRoomChatPolicyService,
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
  ) {}

  async history(
    actor: RoomActor,
    roomId: string,
    q: HistoryQuery,
  ): Promise<Paginated<ChatMessagePayload>> {
    await this.policy.assertActiveMember(roomId, actor.id);

    const isHotPage = q.page === 1 && !q.before && (q.order ?? 'desc') === 'desc';
    if (isHotPage) {
      const cached = await this.cache.readRecent(roomId, q.limit);
      if (cached.length > 0) return buildPaginated(cached, cached.length, q.page, q.limit);
    }

    const includeDeleted = await this.canSeeDeleted(actor, roomId);
    const [rows, total] = await this.repo.listMessages(roomId, {
      skip: q.skip,
      take: q.limit,
      before: q.before,
      includeDeleted,
      order: q.order,
    });
    return buildPaginated(
      rows.map((r) => toChatMessagePayload(r)),
      total,
      q.page,
      q.limit,
    );
  }

  async search(
    actor: RoomActor,
    roomId: string,
    q: SearchQuery,
  ): Promise<Paginated<ChatMessagePayload>> {
    await this.policy.assertActiveMember(roomId, actor.id);

    const [rows, total] = await this.repo.searchMessages(roomId, {
      skip: q.skip,
      take: q.limit,
      term: q.q,
      senderId: q.senderId,
      type: q.type,
      from: q.from,
      to: q.to,
      pinnedOnly: q.pinnedOnly,
      announcementsOnly: q.announcementsOnly,
    });
    return buildPaginated(
      rows.map((r) => toChatMessagePayload(r)),
      total,
      q.page,
      q.limit,
    );
  }

  /** Visible messages newer than the caller's read mark. */
  async unreadCount(actor: RoomActor, roomId: string): Promise<{ unread: number }> {
    await this.policy.assertActiveMember(roomId, actor.id);
    const cursor = await this.repo.findCursor(roomId, actor.id);
    const unread = await this.repo.countUnread(roomId, cursor?.lastReadAt ?? null);
    return { unread };
  }

  /** Moderators see soft-deleted rows; recalled rows stay hidden from everyone. */
  private async canSeeDeleted(actor: RoomActor, roomId: string): Promise<boolean> {
    const room = await this.rooms.findById(roomId);
    if (!room) return false;
    const role = await this.permissions.resolveEffectiveRole(room, actor.id);
    return role !== null && ELEVATED_VIDEO_ROOM_ROLES.includes(role);
  }
}
