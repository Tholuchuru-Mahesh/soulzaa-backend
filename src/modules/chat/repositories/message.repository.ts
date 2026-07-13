import { Inject, Injectable } from '@nestjs/common';
import {
  AttachmentType,
  DirectMessage,
  DirectMessageReport,
  DirectMessageType,
  MessageAttachment,
  MessageReaction,
  Prisma,
  ReportReason,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { chatRateKey } from '../constants/chat.constants';

/** A message with everything a view needs, in one read. */
export type MessageWithRelations = DirectMessage & {
  attachments: MessageAttachment[];
  reactions: MessageReaction[];
};

const WITH_RELATIONS = {
  attachments: true,
  reactions: true,
} satisfies Prisma.DirectMessageInclude;

export interface CreateMessageInput {
  conversationId: string;
  senderId: string;
  type: DirectMessageType;
  content: string;
  clientId: string;
  replyToId: string | null;
  metadata: Prisma.InputJsonValue | undefined;
  attachments: {
    type: AttachmentType;
    storageKey: string;
    thumbnailKey: string | null;
    mimeType: string;
    sizeBytes: number;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    waveform: number[];
    filename: string | null;
  }[];
}

/**
 * Data layer for direct messages: Postgres (direct_messages, attachments,
 * reactions) plus the Redis send-rate counter. Pure persistence — permission
 * checks and fan-out live in the service.
 */
@Injectable()
export class MessageRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  // ---- Messages ----

  /**
   * Persist a message and its attachments in one transaction.
   *
   * Idempotent on `(conversationId, clientId)`: when an optimistic client
   * retries a send it never saw the ack for, the unique index rejects the
   * duplicate and we return the original row. Without this, every flaky network
   * would double-post — the single most visible bug in an optimistic-UI chat.
   */
  async create(
    input: CreateMessageInput,
  ): Promise<{ message: MessageWithRelations; created: boolean }> {
    try {
      const message = await this.prisma.directMessage.create({
        data: {
          conversationId: input.conversationId,
          senderId: input.senderId,
          type: input.type,
          content: input.content,
          clientId: input.clientId,
          replyToId: input.replyToId,
          metadata: input.metadata,
          attachments: input.attachments.length ? { create: input.attachments } : undefined,
        },
        include: WITH_RELATIONS,
      });
      return { message, created: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.findByClientId(input.conversationId, input.clientId);
        if (existing) return { message: existing, created: false };
      }
      throw e;
    }
  }

  findById(id: string): Promise<MessageWithRelations | null> {
    return this.prisma.directMessage.findUnique({ where: { id }, include: WITH_RELATIONS });
  }

  findByClientId(conversationId: string, clientId: string): Promise<MessageWithRelations | null> {
    return this.prisma.directMessage.findUnique({
      where: { conversationId_clientId: { conversationId, clientId } },
      include: WITH_RELATIONS,
    });
  }

  /**
   * History, newest-first. `before` (a message id) switches to keyset
   * pagination — the only mode that stays correct while new messages arrive
   * mid-scroll, which offset paging cannot do. `clearedAt` hides history the
   * user deleted for themselves without touching the peer's copy.
   */
  async list(
    conversationId: string,
    opts: { skip: number; take: number; before?: string; clearedAt: Date | null },
  ): Promise<[MessageWithRelations[], number]> {
    const where: Prisma.DirectMessageWhereInput = { conversationId };
    if (opts.clearedAt) where.createdAt = { gt: opts.clearedAt };

    if (opts.before) {
      const cursor = await this.prisma.directMessage.findUnique({
        where: { id: opts.before },
        select: { createdAt: true },
      });
      if (cursor) {
        where.createdAt = opts.clearedAt
          ? { gt: opts.clearedAt, lt: cursor.createdAt }
          : { lt: cursor.createdAt };
      }
    }

    return this.prisma.$transaction([
      this.prisma.directMessage.findMany({
        where,
        include: WITH_RELATIONS,
        take: opts.take,
        // Keyset mode anchors on `before`; skip would double-advance the cursor.
        ...(opts.before ? {} : { skip: opts.skip }),
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.directMessage.count({ where }),
    ]);
  }

  /** Soft-delete, so the peer's history stays consistent and receipts still resolve. */
  softDelete(id: string): Promise<DirectMessage> {
    return this.prisma.directMessage.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date(), content: '' },
    });
  }

  /** Edit a message body. `editedAt` is what tells the client to render "edited". */
  edit(id: string, content: string): Promise<MessageWithRelations> {
    return this.prisma.directMessage.update({
      where: { id },
      data: { content, editedAt: new Date() },
      include: WITH_RELATIONS,
    });
  }

  // ---- Reports ----

  createReport(input: {
    conversationId: string;
    messageId: string | null;
    reporterId: string;
    targetUserId: string;
    reason: ReportReason;
    description: string | null;
  }): Promise<DirectMessageReport> {
    return this.prisma.directMessageReport.create({ data: input });
  }

  // ---- Reactions ----

  /** Idempotent: reacting twice with the same emoji is a no-op, not an error. */
  async addReaction(messageId: string, userId: string, emoji: string): Promise<boolean> {
    try {
      await this.prisma.messageReaction.create({ data: { messageId, userId, emoji } });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
  }

  async removeReaction(messageId: string, userId: string, emoji: string): Promise<boolean> {
    const { count } = await this.prisma.messageReaction.deleteMany({
      where: { messageId, userId, emoji },
    });
    return count > 0;
  }

  // ---- Anti-abuse ----

  /**
   * Rolling send-rate counter. Returns the count within the current window;
   * the service compares it against the configured ceiling. INCR + EXPIRE on
   * first hit is the standard fixed-window counter — cheap, and good enough
   * for abuse control (exactness at the window boundary does not matter here).
   */
  async bumpSendRate(userId: string, windowSeconds: number): Promise<number> {
    const key = chatRateKey(userId);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSeconds);
    return count;
  }
}
