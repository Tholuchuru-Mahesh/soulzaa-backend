import { Inject, Injectable } from '@nestjs/common';
import {
  AttachmentType,
  DirectMessage,
  DirectMessageReport,
  DirectMessageType,
  HiddenMessage,
  LinkPreview,
  MessageAttachment,
  MessageReaction,
  Prisma,
  ReportReason,
  StarredMessage,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { chatRateKey } from '../constants/chat.constants';

/** A message with everything a view needs, in one read. */
export type MessageWithRelations = DirectMessage & {
  attachments: MessageAttachment[];
  reactions: MessageReaction[];
  linkPreview: LinkPreview | null;
};

const WITH_RELATIONS = {
  attachments: true,
  reactions: true,
  // Joined rather than fetched per message: a preview is a shared row, and a page
  // of thirty messages quoting the same link resolves it once.
  linkPreview: true,
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
    opts: {
      skip: number;
      take: number;
      before?: string;
      clearedAt: Date | null;
      /** The reader. Their "delete for me" rows are excluded. */
      viewerId: string;
    },
  ): Promise<[MessageWithRelations[], number]> {
    const where: Prisma.DirectMessageWhereInput = {
      conversationId,
      // "Delete for me", per message. `clearedAt` below hides everything before a
      // cut-off; this hides individual messages the user removed for themselves.
      // Served by the unique index on (messageId, userId).
      NOT: { hiddenBy: { some: { userId: opts.viewerId } } },
    };
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

  // ---- Delta support ----

  /**
   * Bump a message's `updatedAt` because something in one of its *child* tables
   * changed — a reaction, a star.
   *
   * This is what makes those changes visible to `GET /chat/sync`. A removed
   * reaction leaves no row behind to timestamp, so a delta over the reactions table
   * could never see it; touching the parent instead makes the message the unit of
   * change, and `MessageView` already carries the collapsed reactions, so one delta
   * row re-states the whole truth about that message.
   *
   * The cost is that a star (which is private) also re-sends the message to the
   * peer. That is a redundant but *identical* row — the peer's `isStarred` is
   * resolved per-viewer and stays false — so it leaks nothing, and applying it twice
   * is a no-op.
   */
  private touch(messageId: string, tx?: Prisma.TransactionClient): Promise<unknown> {
    return (tx ?? this.prisma).directMessage.update({
      where: { id: messageId },
      data: { updatedAt: new Date() },
    });
  }

  // ---- Reactions ----

  /** Idempotent: reacting twice with the same emoji is a no-op, not an error. */
  async addReaction(messageId: string, userId: string, emoji: string): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.messageReaction.create({ data: { messageId, userId, emoji } });
        await this.touch(messageId, tx);
      });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
  }

  async removeReaction(messageId: string, userId: string, emoji: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.messageReaction.deleteMany({
        where: { messageId, userId, emoji },
      });
      // Only touch when something actually changed; a no-op unreact must not
      // manufacture a delta row for every client watching the conversation.
      if (count > 0) await this.touch(messageId, tx);
      return count > 0;
    });
  }

  // ---- Starring (private to one user) ----

  /** Idempotent: starring twice is a no-op, not a 409. */
  async star(messageId: string, userId: string, conversationId: string): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.starredMessage.create({ data: { messageId, userId, conversationId } });
        await this.touch(messageId, tx);
      });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
  }

  async unstar(messageId: string, userId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.starredMessage.deleteMany({ where: { messageId, userId } });
      if (count > 0) await this.touch(messageId, tx);
      return count > 0;
    });
  }

  countStars(userId: string): Promise<number> {
    return this.prisma.starredMessage.count({ where: { userId } });
  }

  /**
   * Which of these messages the viewer starred. One query per page, never one per
   * row — the N+1 that would otherwise creep into every history read.
   */
  async starredIdsAmong(messageIds: string[], userId: string): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set();
    const rows = await this.prisma.starredMessage.findMany({
      where: { userId, messageId: { in: messageIds } },
      select: { messageId: true },
    });
    return new Set(rows.map((r) => r.messageId));
  }

  /**
   * The user's starred messages, newest first. Deleted and self-hidden messages are
   * excluded: a Starred screen that lists tombstones is listing nothing.
   */
  async listStarred(
    userId: string,
    opts: { skip: number; take: number; conversationId?: string; cursor?: string },
  ): Promise<[(StarredMessage & { message: MessageWithRelations })[], number]> {
    const where: Prisma.StarredMessageWhereInput = {
      userId,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      message: {
        isDeleted: false,
        NOT: { hiddenBy: { some: { userId } } },
      },
    };

    if (opts.cursor) {
      const cursor = await this.prisma.starredMessage.findUnique({
        where: { id: opts.cursor },
        select: { createdAt: true },
      });
      if (cursor) where.createdAt = { lt: cursor.createdAt };
    }

    return this.prisma.$transaction([
      this.prisma.starredMessage.findMany({
        where,
        include: { message: { include: WITH_RELATIONS } },
        take: opts.take,
        ...(opts.cursor ? {} : { skip: opts.skip }),
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.starredMessage.count({ where }),
    ]);
  }

  // ---- Delete for me ----

  /**
   * Hide one message from one user. Idempotent, and it drops the user's star in
   * the same transaction — a starred message the user then deleted for themselves
   * must not survive in their Starred list.
   */
  async hide(messageId: string, userId: string, conversationId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.hiddenMessage.upsert({
        where: { messageId_userId: { messageId, userId } },
        create: { messageId, userId, conversationId },
        update: {},
      }),
      this.prisma.starredMessage.deleteMany({ where: { messageId, userId } }),
    ]);
  }

  /** Which of these messages the user hid. One query per page, never one per row. */
  async hiddenIdsAmong(messageIds: string[], userId: string): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set();
    const rows = await this.prisma.hiddenMessage.findMany({
      where: { userId, messageId: { in: messageIds } },
      select: { messageId: true },
    });
    return new Set(rows.map((r) => r.messageId));
  }

  isHidden(messageId: string, userId: string): Promise<HiddenMessage | null> {
    return this.prisma.hiddenMessage.findUnique({
      where: { messageId_userId: { messageId, userId } },
    });
  }

  /**
   * The newest message in a conversation that this user has NOT hidden.
   *
   * Only called when the conversation's denormalised `lastMessageId` is one the
   * user hid — a rare path, and the reason there is no per-user preview column:
   * the fallback is cheap precisely because it almost never runs.
   */
  newestVisible(conversationId: string, userId: string): Promise<MessageWithRelations | null> {
    return this.prisma.directMessage.findFirst({
      where: {
        conversationId,
        NOT: { hiddenBy: { some: { userId } } },
      },
      include: WITH_RELATIONS,
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---- Conversation media ----

  /**
   * The media in one conversation, newest first, filtered by kind.
   *
   * Queries the *attachments*, not the messages, because that is the question being
   * asked — "show me the photos in this chat" is about files, and a message-first
   * query would have to fetch and discard every text message between them.
   *
   * Honours the same visibility rules as history: nothing deleted, nothing the
   * viewer hid for themselves, nothing before their clear-history cut-off. A media
   * tab that surfaces a photo the user deleted is a privacy bug.
   */
  async listMedia(
    conversationId: string,
    opts: {
      skip: number;
      take: number;
      viewerId: string;
      clearedAt: Date | null;
      types: AttachmentType[];
    },
  ): Promise<[MessageWithRelations[], number]> {
    const where: Prisma.DirectMessageWhereInput = {
      conversationId,
      isDeleted: false,
      NOT: { hiddenBy: { some: { userId: opts.viewerId } } },
      attachments: { some: { type: { in: opts.types } } },
      ...(opts.clearedAt ? { createdAt: { gt: opts.clearedAt } } : {}),
    };

    return this.prisma.$transaction([
      this.prisma.directMessage.findMany({
        where,
        include: WITH_RELATIONS,
        take: opts.take,
        skip: opts.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.directMessage.count({ where }),
    ]);
  }

  /**
   * Messages in a conversation that carry a link, newest first.
   *
   * The Links tab. Driven off `linkPreviewId` rather than scanning message bodies
   * for `http`: the preview row is only created when a link was actually found and
   * accepted at send time, so this is an indexed lookup instead of a table scan
   * with a LIKE.
   */
  async listLinks(
    conversationId: string,
    opts: { skip: number; take: number; viewerId: string; clearedAt: Date | null },
  ): Promise<[MessageWithRelations[], number]> {
    const where: Prisma.DirectMessageWhereInput = {
      conversationId,
      isDeleted: false,
      linkPreviewId: { not: null },
      NOT: { hiddenBy: { some: { userId: opts.viewerId } } },
      ...(opts.clearedAt ? { createdAt: { gt: opts.clearedAt } } : {}),
    };

    return this.prisma.$transaction([
      this.prisma.directMessage.findMany({
        where,
        include: WITH_RELATIONS,
        take: opts.take,
        skip: opts.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.directMessage.count({ where }),
    ]);
  }

  // ---- Link previews ----

  /**
   * Find a fresh preview for a URL, or claim a PENDING row to scrape.
   *
   * Returns `{ preview, needsFetch }`. `needsFetch` is false when a READY row is
   * still inside its TTL — a link shared a thousand times is scraped once, for the
   * whole platform. A FAILED row inside its TTL also needs no fetch: a dead link
   * must not be re-crawled on every render.
   */
  async claimLinkPreview(
    urlHash: string,
    url: string,
    ttlDays: number,
  ): Promise<{ preview: LinkPreview; needsFetch: boolean }> {
    const now = new Date();
    const existing = await this.prisma.linkPreview.findUnique({ where: { urlHash } });

    if (existing && existing.expiresAt && existing.expiresAt > now) {
      return { preview: existing, needsFetch: existing.status === 'PENDING' };
    }

    const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000);
    const preview = await this.prisma.linkPreview.upsert({
      where: { urlHash },
      create: { urlHash, url, status: 'PENDING', expiresAt },
      update: { status: 'PENDING', url, expiresAt },
    });
    return { preview, needsFetch: true };
  }

  attachLinkPreview(messageId: string, linkPreviewId: string): Promise<DirectMessage> {
    return this.prisma.directMessage.update({
      where: { id: messageId },
      data: { linkPreviewId },
    });
  }

  finishLinkPreview(
    id: string,
    data: {
      status: 'READY' | 'FAILED';
      title?: string | null;
      description?: string | null;
      siteName?: string | null;
      imageKey?: string | null;
      imageWidth?: number | null;
      imageHeight?: number | null;
    },
  ): Promise<LinkPreview> {
    return this.prisma.linkPreview.update({
      where: { id },
      data: { ...data, fetchedAt: new Date() },
    });
  }

  findLinkPreview(id: string): Promise<LinkPreview | null> {
    return this.prisma.linkPreview.findUnique({ where: { id } });
  }

  // ---- Delta sync ----

  /**
   * Every message that changed since `since`, across the conversations named.
   *
   * "Changed" is one column — `updatedAt` — and that is the entire trick. Creation,
   * edit, soft-delete and (via {@link touch}) reactions and stars all land on it, so
   * one indexed scan replaces four separate deltas that would each have needed their
   * own cursor and their own way of representing a deletion.
   *
   * `>=` rather than `>`: the boundary re-sends whatever shares the cursor's exact
   * millisecond. Applying a message twice is a no-op keyed by id; *missing* one is a
   * message the user never sees. At-least-once is the only safe direction here.
   *
   * `clearedAt` is per-conversation, so conversations the user cleared history in get
   * their own floor. They are rare, so they cost an extra OR branch each and the rest
   * of the conversations share one cheap `IN`.
   */
  async changedSince(opts: {
    viewerId: string;
    since: Date;
    take: number;
    /** Conversations the viewer is in, each with their own clear-history floor. */
    scopes: { conversationId: string; clearedAt: Date | null }[];
  }): Promise<MessageWithRelations[]> {
    if (opts.scopes.length === 0) return [];

    const plain = opts.scopes.filter((s) => !s.clearedAt).map((s) => s.conversationId);
    const cleared = opts.scopes.filter(
      (s): s is { conversationId: string; clearedAt: Date } => s.clearedAt !== null,
    );

    const scopeClause: Prisma.DirectMessageWhereInput[] = [
      ...(plain.length ? [{ conversationId: { in: plain } }] : []),
      ...cleared.map((s) => ({
        conversationId: s.conversationId,
        createdAt: { gt: s.clearedAt },
      })),
    ];

    return this.prisma.directMessage.findMany({
      where: {
        OR: scopeClause,
        updatedAt: { gte: opts.since },
        // A message the viewer deleted for themselves must not come back just because
        // the peer reacted to it.
        NOT: { hiddenBy: { some: { userId: opts.viewerId } } },
      },
      include: WITH_RELATIONS,
      // Oldest change first: the client applies the delta in the order it happened, and
      // the last row it applies is the one its next cursor is taken from.
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: opts.take,
    });
  }

  /**
   * Messages the viewer hid since `since`, on any device.
   *
   * Delete-for-me leaves no tombstone on the message — that is the whole point of it
   * — so the hide row *is* the event, and it is the only way another of this user's
   * devices can learn the message is gone.
   */
  async hiddenSince(userId: string, since: Date): Promise<string[]> {
    const rows = await this.prisma.hiddenMessage.findMany({
      where: { userId, createdAt: { gte: since } },
      select: { messageId: true },
    });
    return rows.map((r) => r.messageId);
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
