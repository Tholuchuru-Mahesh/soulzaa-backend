import { Inject, Injectable } from '@nestjs/common';
import {
  BlockedWordAction,
  BlockedWordSeverity,
  ChatMessageType,
  ChatReport,
  ChatReportStatus,
  PinnedMessage,
  Prisma,
  ReportReason,
  RoomMessage,
} from '@prisma/client';
import type { ChatBlockedWord } from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { BlockedWordRepository } from 'src/infra/content-moderation';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import {
  chatDedupKey,
  chatRateKey,
  chatReactRateKey,
  chatSlowModeKey,
  chatViolationKey,
} from '../constants/chat.constants';

/**
 * Data layer for AR-4 chat: Postgres (room_messages, pinned_messages,
 * chat_reports) plus the Redis anti-abuse counters (rate limit, slow-mode,
 * duplicate suppression, violation history). Pure persistence — permission
 * checks, blocked-word scanning and escalation live in the service. Every
 * Redis op touches a single `{roomId}` hash-tagged key.
 *
 * The `chat_blocked_words` dictionary is global (no room scoping) and is owned
 * by the shared `BlockedWordRepository` (src/infra/content-moderation); the
 * admin CRUD methods below simply delegate to it so `ChatService`'s call sites
 * don't change.
 */
@Injectable()
export class ChatRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly words: BlockedWordRepository,
  ) {}

  // ---- Messages ----

  createMessage(input: {
    roomId: string;
    senderId: string;
    type: ChatMessageType;
    content: string;
    gifUrl: string | null;
    mentions: string[];
    replyToId: string | null;
  }): Promise<RoomMessage> {
    return this.prisma.roomMessage.create({ data: input });
  }

  getMessage(id: string): Promise<RoomMessage | null> {
    return this.prisma.roomMessage.findUnique({ where: { id } });
  }

  /**
   * Paginated history newest-first. `before` (a message id) switches to keyset
   * pagination: only messages older than that message are returned. Moderators
   * see soft-deleted rows; everyone else has them filtered out.
   */
  async listMessages(
    roomId: string,
    opts: { skip: number; take: number; before?: string; includeDeleted: boolean },
  ): Promise<[RoomMessage[], number]> {
    const where: Prisma.RoomMessageWhereInput = {
      roomId,
      ...(opts.includeDeleted ? {} : { isDeleted: false }),
    };

    if (opts.before) {
      const cursor = await this.prisma.roomMessage.findUnique({
        where: { id: opts.before },
        select: { createdAt: true },
      });
      if (cursor) where.createdAt = { lt: cursor.createdAt };
    }

    return this.prisma.$transaction([
      this.prisma.roomMessage.findMany({
        where,
        take: opts.take,
        ...(opts.before ? {} : { skip: opts.skip }),
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.roomMessage.count({ where }),
    ]);
  }

  async softDeleteMessage(id: string, byUserId: string): Promise<void> {
    await this.prisma.roomMessage.update({
      where: { id },
      data: { isDeleted: true, deletedBy: byUserId, deletedAt: new Date() },
    });
  }

  // ---- Pins ----

  pin(input: { roomId: string; messageId: string; pinnedBy: string }): Promise<PinnedMessage> {
    return this.prisma.pinnedMessage.create({ data: input });
  }

  getActivePin(roomId: string, messageId: string): Promise<PinnedMessage | null> {
    return this.prisma.pinnedMessage.findFirst({
      where: { roomId, messageId, isActive: true },
    });
  }

  countActivePins(roomId: string): Promise<number> {
    return this.prisma.pinnedMessage.count({ where: { roomId, isActive: true } });
  }

  listActivePins(roomId: string): Promise<PinnedMessage[]> {
    return this.prisma.pinnedMessage.findMany({
      where: { roomId, isActive: true },
      orderBy: { pinnedAt: 'desc' },
    });
  }

  async unpin(id: string, unpinnedBy: string): Promise<void> {
    await this.prisma.pinnedMessage.update({
      where: { id },
      data: { isActive: false, unpinnedBy, unpinnedAt: new Date() },
    });
  }

  // ---- Reports ----

  createReport(input: {
    roomId: string;
    messageId: string;
    reporterId: string;
    targetUserId: string;
    reason: ReportReason;
    description: string | null;
  }): Promise<ChatReport> {
    return this.prisma.chatReport.create({
      data: { ...input, ...auditCreate(input.reporterId) },
    });
  }

  getReport(id: string): Promise<ChatReport | null> {
    return this.prisma.chatReport.findUnique({ where: { id } });
  }

  findOpenReport(
    roomId: string,
    reporterId: string,
    messageId: string,
  ): Promise<ChatReport | null> {
    return this.prisma.chatReport.findFirst({
      where: { roomId, reporterId, messageId, status: ChatReportStatus.PENDING },
    });
  }

  listReports(
    roomId: string,
    skip: number,
    take: number,
    status?: ChatReportStatus,
  ): Promise<[ChatReport[], number]> {
    const where: Prisma.ChatReportWhereInput = { roomId, ...(status ? { status } : {}) };
    return this.prisma.$transaction([
      this.prisma.chatReport.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.chatReport.count({ where }),
    ]);
  }

  async reviewReport(
    id: string,
    reviewerId: string,
    status: ChatReportStatus,
    resolutionAction: string | null,
  ): Promise<void> {
    await this.prisma.chatReport.update({
      where: { id },
      data: {
        status,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        resolutionAction,
        ...auditUpdate(reviewerId),
      },
    });
  }

  // ---- Blocked-word dictionary ----
  // The `chat_blocked_words` table is global (no room scoping) and its
  // persistence now lives in the shared `BlockedWordRepository`
  // (src/infra/content-moderation). These methods delegate to it so the
  // admin CRUD call sites in ChatService are unaffected by the move.

  listWords(
    skip: number,
    take: number,
    filter: { language?: string; enabled?: boolean },
  ): Promise<[ChatBlockedWord[], number]> {
    return this.words.listWords(skip, take, filter);
  }

  getWord(id: string): Promise<ChatBlockedWord | null> {
    return this.words.getWord(id);
  }

  createWord(
    input: {
      pattern: string;
      isRegex: boolean;
      language: string;
      severity: BlockedWordSeverity;
      action: BlockedWordAction;
      enabled: boolean;
      notes: string | null;
    },
    actorId: string,
  ): Promise<ChatBlockedWord> {
    return this.words.createWord(input, actorId);
  }

  updateWord(
    id: string,
    data: Prisma.ChatBlockedWordUpdateInput,
    actorId: string,
  ): Promise<ChatBlockedWord> {
    return this.words.updateWord(id, data, actorId);
  }

  deleteWord(id: string): Promise<void> {
    return this.words.deleteWord(id);
  }

  // ---- Redis anti-abuse counters (hot path) ----

  /** Increment the rolling rate window; true when the cap is exceeded. */
  async hitRateLimit(
    roomId: string,
    userId: string,
    max: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const count = await this.cache.increment(chatRateKey(roomId, userId), {
      ttlSeconds: windowSeconds,
    });
    return count > max;
  }

  /** Same rolling-window primitive for ephemeral reaction bursts. */
  async hitReactRateLimit(
    roomId: string,
    userId: string,
    max: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const count = await this.cache.increment(chatReactRateKey(roomId, userId), {
      ttlSeconds: windowSeconds,
    });
    return count > max;
  }

  isSlowModeActive(roomId: string, userId: string): Promise<boolean> {
    return this.cache.exists(chatSlowModeKey(roomId, userId));
  }

  async setSlowMode(roomId: string, userId: string, seconds: number): Promise<void> {
    if (seconds <= 0) return;
    await this.redis.set(chatSlowModeKey(roomId, userId), '1', 'EX', seconds);
  }

  /**
   * Mark a content hash as seen for the dedup window. Returns true when the
   * message is a duplicate (key already present). Atomic via SET NX.
   */
  async isDuplicate(
    roomId: string,
    userId: string,
    contentHash: string,
    windowSeconds: number,
  ): Promise<boolean> {
    const res = await this.redis.set(
      chatDedupKey(roomId, userId, contentHash),
      '1',
      'EX',
      windowSeconds,
      'NX',
    );
    return res === null;
  }

  /** Increment the rolling blocked-word violation counter; returns the new count. */
  incrViolation(roomId: string, userId: string, windowSeconds: number): Promise<number> {
    return this.cache.increment(chatViolationKey(roomId, userId), { ttlSeconds: windowSeconds });
  }
}
