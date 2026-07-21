import { Injectable } from '@nestjs/common';
import {
  Prisma,
  VideoRoomChatCursor,
  VideoRoomMessage,
  VideoRoomMessagePin,
  VideoRoomMessageType,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateMessageInput {
  roomId: string;
  senderId: string;
  type: VideoRoomMessageType;
  content: string;
  mentions: string[];
  mentionScope?: string | null;
  replyToId?: string | null;
  forwardedFromId?: string | null;
  attachments?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
}

export interface ListMessagesOptions {
  skip: number;
  take: number;
  /** Keyset cursor — only messages older than this id. Suppresses `skip`. */
  before?: string;
  /** Moderators see soft-deleted rows. Recalled rows are hidden from everyone. */
  includeDeleted: boolean;
  order?: 'asc' | 'desc';
}

export interface SearchMessagesOptions {
  skip: number;
  take: number;
  term?: string;
  senderId?: string;
  type?: VideoRoomMessageType;
  from?: Date;
  to?: Date;
  /** Restrict to messages with an ACTIVE pin. Empty active-pin set ⇒ empty page. */
  pinnedOnly?: boolean;
  /** Restrict to ANNOUNCEMENT-type messages. Wins over a conflicting `type`. */
  announcementsOnly?: boolean;
}

export interface UpsertCursorInput {
  roomId: string;
  userId: string;
  readMessageId?: string;
  readAt?: Date;
  deliveredMessageId?: string;
  deliveredAt?: Date;
}

/**
 * Data layer for VR-9 chat: `video_room_messages`, `video_room_message_pins` and
 * `video_room_chat_cursors`. Pure persistence — every policy decision, rate check
 * and Redis interaction lives in the services. No service may touch Prisma
 * directly.
 *
 * Visibility rule encoded here once: soft-DELETED rows are visible to moderators
 * (that is what makes moderation auditable), but RECALLED rows are hidden from
 * everyone — recall is the sender's "unsend", so surfacing it to moderators would
 * defeat the feature.
 */
@Injectable()
export class VideoRoomChatRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Messages ----

  createMessage(input: CreateMessageInput): Promise<VideoRoomMessage> {
    return this.prisma.videoRoomMessage.create({
      data: {
        roomId: input.roomId,
        senderId: input.senderId,
        type: input.type,
        content: input.content,
        mentions: input.mentions,
        mentionScope: input.mentionScope ?? null,
        replyToId: input.replyToId ?? null,
        forwardedFromId: input.forwardedFromId ?? null,
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
  }

  findMessage(id: string): Promise<VideoRoomMessage | null> {
    return this.prisma.videoRoomMessage.findUnique({ where: { id } });
  }

  listMessagesByIds(ids: string[]): Promise<VideoRoomMessage[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.videoRoomMessage.findMany({ where: { id: { in: ids } } });
  }

  async listMessages(
    roomId: string,
    opts: ListMessagesOptions,
  ): Promise<[VideoRoomMessage[], number]> {
    const where: Prisma.VideoRoomMessageWhereInput = {
      roomId,
      recalledAt: null,
      ...(opts.includeDeleted ? {} : { deletedAt: null }),
    };

    if (opts.before) {
      const cursor = await this.prisma.videoRoomMessage.findUnique({
        where: { id: opts.before },
        select: { createdAt: true },
      });
      if (cursor) where.createdAt = { lt: cursor.createdAt };
    }

    return this.prisma.$transaction([
      this.prisma.videoRoomMessage.findMany({
        where,
        take: opts.take,
        ...(opts.before ? {} : { skip: opts.skip }),
        orderBy: { createdAt: opts.order ?? 'desc' },
      }),
      this.prisma.videoRoomMessage.count({ where }),
    ]);
  }

  async searchMessages(
    roomId: string,
    opts: SearchMessagesOptions,
  ): Promise<[VideoRoomMessage[], number]> {
    // Resolved up front so an empty active-pin set can still filter (`id: { in:
    // [] }`) rather than being skipped and returning an unfiltered page — the
    // classic bug this exists to avoid.
    let pinnedMessageIds: string[] | undefined;
    if (opts.pinnedOnly) {
      const pins = await this.listActivePins(roomId);
      pinnedMessageIds = pins.map((p) => p.messageId);
    }

    const where: Prisma.VideoRoomMessageWhereInput = {
      roomId,
      deletedAt: null,
      recalledAt: null,
      ...(opts.term ? { content: { contains: opts.term, mode: 'insensitive' } } : {}),
      ...(opts.senderId ? { senderId: opts.senderId } : {}),
      // `announcementsOnly` wins over an explicit conflicting `type`.
      ...(opts.announcementsOnly
        ? { type: VideoRoomMessageType.ANNOUNCEMENT }
        : opts.type
          ? { type: opts.type }
          : {}),
      ...(opts.from || opts.to
        ? {
            createdAt: {
              ...(opts.from ? { gte: opts.from } : {}),
              ...(opts.to ? { lte: opts.to } : {}),
            },
          }
        : {}),
      ...(pinnedMessageIds ? { id: { in: pinnedMessageIds } } : {}),
    };

    return this.prisma.$transaction([
      this.prisma.videoRoomMessage.findMany({
        where,
        skip: opts.skip,
        take: opts.take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.videoRoomMessage.count({ where }),
    ]);
  }

  editMessage(id: string, content: string): Promise<VideoRoomMessage> {
    return this.prisma.videoRoomMessage.update({
      where: { id },
      data: { content, editedAt: new Date(), editCount: { increment: 1 } },
    });
  }

  async softDeleteMessage(id: string, byUserId: string): Promise<void> {
    await this.prisma.videoRoomMessage.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: byUserId },
    });
  }

  async recallMessage(id: string): Promise<void> {
    await this.prisma.videoRoomMessage.update({
      where: { id },
      data: { recalledAt: new Date() },
    });
  }

  // ---- Pins ----

  createPin(input: {
    roomId: string;
    messageId: string;
    pinnedBy: string;
  }): Promise<VideoRoomMessagePin> {
    return this.prisma.videoRoomMessagePin.create({ data: input });
  }

  findActivePin(roomId: string, messageId: string): Promise<VideoRoomMessagePin | null> {
    return this.prisma.videoRoomMessagePin.findFirst({
      where: { roomId, messageId, isActive: true },
    });
  }

  listActivePins(roomId: string): Promise<VideoRoomMessagePin[]> {
    return this.prisma.videoRoomMessagePin.findMany({
      where: { roomId, isActive: true },
      orderBy: { pinnedAt: 'desc' },
    });
  }

  countActivePins(roomId: string): Promise<number> {
    return this.prisma.videoRoomMessagePin.count({ where: { roomId, isActive: true } });
  }

  async deactivatePin(id: string, unpinnedBy: string): Promise<void> {
    await this.prisma.videoRoomMessagePin.update({
      where: { id },
      data: { isActive: false, unpinnedBy, unpinnedAt: new Date() },
    });
  }

  // ---- Read cursors ----

  async upsertCursor(input: UpsertCursorInput): Promise<void> {
    const fields = {
      ...(input.readMessageId ? { lastReadMessageId: input.readMessageId } : {}),
      ...(input.readAt ? { lastReadAt: input.readAt } : {}),
      ...(input.deliveredMessageId ? { lastDeliveredMessageId: input.deliveredMessageId } : {}),
      ...(input.deliveredAt ? { lastDeliveredAt: input.deliveredAt } : {}),
    };
    await this.prisma.videoRoomChatCursor.upsert({
      where: { roomId_userId: { roomId: input.roomId, userId: input.userId } },
      create: { roomId: input.roomId, userId: input.userId, ...fields },
      update: fields,
    });
  }

  findCursor(roomId: string, userId: string): Promise<VideoRoomChatCursor | null> {
    return this.prisma.videoRoomChatCursor.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
  }

  /** Cursors at or past `since` — the derived reader list for a message. */
  listReaders(roomId: string, since: Date): Promise<VideoRoomChatCursor[]> {
    return this.prisma.videoRoomChatCursor.findMany({
      where: { roomId, lastReadAt: { gte: since } },
    });
  }

  /** Visible messages newer than a user's read mark. `null` ⇒ everything. */
  countUnread(roomId: string, since: Date | null): Promise<number> {
    return this.prisma.videoRoomMessage.count({
      where: {
        roomId,
        deletedAt: null,
        recalledAt: null,
        ...(since ? { createdAt: { gt: since } } : {}),
      },
    });
  }

  /** The ANNOUNCEMENT-type message projecting a given announcement, if any. */
  findByAnnouncementId(roomId: string, announcementId: string): Promise<VideoRoomMessage | null> {
    return this.prisma.videoRoomMessage.findFirst({
      where: {
        roomId,
        type: VideoRoomMessageType.ANNOUNCEMENT,
        metadata: { path: ['announcementId'], equals: announcementId },
      },
    });
  }
}
