import { Inject, Injectable } from '@nestjs/common';
import {
  BlockedWordAction,
  BlockedWordSeverity,
  ChatBlockedWord,
  ChatMessageType,
  ChatReport,
  ChatReportStatus,
  PinnedMessage,
  Prisma,
  ReportReason,
  RoomMessage,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
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
 * chat_reports, chat_blocked_words) plus the Redis anti-abuse counters
 * (rate limit, slow-mode, duplicate suppression, violation history). Pure
 * persistence — permission checks, blocked-word scanning and escalation live in
 * the service. Every Redis op touches a single `{roomId}` hash-tagged key.
 */
@Injectable()
export class ChatRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
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

  listEnabledWords(): Promise<ChatBlockedWord[]> {
    return this.prisma.chatBlockedWord.findMany({ where: { enabled: true } });
  }

  listWords(
    skip: number,
    take: number,
    filter: { language?: string; enabled?: boolean },
  ): Promise<[ChatBlockedWord[], number]> {
    const where: Prisma.ChatBlockedWordWhereInput = {
      ...(filter.language ? { language: filter.language } : {}),
      ...(filter.enabled !== undefined ? { enabled: filter.enabled } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.chatBlockedWord.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.chatBlockedWord.count({ where }),
    ]);
  }

  getWord(id: string): Promise<ChatBlockedWord | null> {
    return this.prisma.chatBlockedWord.findUnique({ where: { id } });
  }

  findWord(pattern: string, language: string): Promise<ChatBlockedWord | null> {
    return this.prisma.chatBlockedWord.findFirst({ where: { pattern, language } });
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
    return this.prisma.chatBlockedWord.create({
      data: { ...input, ...auditCreate(actorId) },
    });
  }

  updateWord(
    id: string,
    data: Prisma.ChatBlockedWordUpdateInput,
    actorId: string,
  ): Promise<ChatBlockedWord> {
    return this.prisma.chatBlockedWord.update({
      where: { id },
      data: { ...data, ...auditUpdate(actorId) },
    });
  }

  async deleteWord(id: string): Promise<void> {
    await this.prisma.chatBlockedWord.delete({ where: { id } });
  }

  /** Idempotent seed helper: create a default word only if the pattern is new. */
  async upsertSeedWord(input: {
    pattern: string;
    isRegex: boolean;
    language: string;
    severity: BlockedWordSeverity;
    action: BlockedWordAction;
  }): Promise<boolean> {
    const existing = await this.prisma.chatBlockedWord.findFirst({
      where: { pattern: input.pattern, language: input.language },
      select: { id: true },
    });
    if (existing) return false;
    await this.prisma.chatBlockedWord.create({
      data: { ...input, enabled: true, notes: 'seed' },
    });
    return true;
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
