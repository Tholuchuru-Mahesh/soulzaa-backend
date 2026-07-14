import { Inject, Injectable } from '@nestjs/common';
import {
  ModerationActionType,
  ModerationBanType,
  ModerationMuteType,
  Prisma,
  ReportReason,
  ReportStatus,
  RoomAppeal,
  RoomBan,
  RoomKick,
  RoomMute,
  RoomReport,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import {
  roomBanKey,
  roomBanSetKey,
  roomKickKey,
  roomKickSetKey,
  roomMuteKey,
  roomMuteSetKey,
} from '../constants/moderation.constants';

/** Display fields for a moderated user, resolved in one batch for list views. */
export interface ModeratedUserSummary {
  username: string | null;
  avatarKey: string | null;
}

/**
 * Data layer for AR-3 moderation: Postgres (room_kicks, room_bans, room_mutes,
 * append-only moderation_actions, moderation_notes, room_reports, room_appeals)
 * plus the Redis kick/ban/mute enforcement caches. Pure persistence — permission
 * checks, realtime enforcement and locking live in the service. The DB is
 * authoritative; Redis is the hot join-gate / mute-check view (single-key ops →
 * Cluster-safe).
 */
@Injectable()
export class ModerationRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  // ---- Kicks (the Kick List) ----

  createKick(input: {
    roomId: string;
    userId: string;
    moderatorId: string;
    reason: string | null;
  }): Promise<RoomKick> {
    return this.prisma.roomKick.create({
      data: {
        roomId: input.roomId,
        userId: input.userId,
        moderatorId: input.moderatorId,
        reason: input.reason,
        ...auditCreate(input.moderatorId),
      },
    });
  }

  findActiveKick(roomId: string, userId: string): Promise<RoomKick | null> {
    return this.prisma.roomKick.findFirst({ where: { roomId, userId, status: 'ACTIVE' } });
  }

  listActiveKicks(roomId: string, skip: number, take: number): Promise<[RoomKick[], number]> {
    const where: Prisma.RoomKickWhereInput = { roomId, status: 'ACTIVE' };
    return this.prisma.$transaction([
      this.prisma.roomKick.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.roomKick.count({ where }),
    ]);
  }

  async liftKick(id: string, liftedBy: string): Promise<void> {
    await this.prisma.roomKick.update({
      where: { id },
      data: { status: 'LIFTED', liftedBy, liftedAt: new Date(), ...auditUpdate(liftedBy) },
    });
  }

  // ---- Bans ----

  createBan(input: {
    roomId: string;
    userId: string;
    moderatorId: string;
    type: ModerationBanType;
    reason: string | null;
    expiresAt: Date | null;
  }): Promise<RoomBan> {
    return this.prisma.roomBan.create({
      data: {
        roomId: input.roomId,
        userId: input.userId,
        moderatorId: input.moderatorId,
        type: input.type,
        reason: input.reason,
        expiresAt: input.expiresAt,
        ...auditCreate(input.moderatorId),
      },
    });
  }

  findActiveBan(roomId: string, userId: string): Promise<RoomBan | null> {
    return this.prisma.roomBan.findFirst({ where: { roomId, userId, status: 'ACTIVE' } });
  }

  getBan(id: string): Promise<RoomBan | null> {
    return this.prisma.roomBan.findUnique({ where: { id } });
  }

  listActiveBans(roomId: string, skip: number, take: number): Promise<[RoomBan[], number]> {
    const where: Prisma.RoomBanWhereInput = { roomId, status: 'ACTIVE' };
    return this.prisma.$transaction([
      this.prisma.roomBan.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.roomBan.count({ where }),
    ]);
  }

  async liftBan(id: string, liftedBy: string, status: 'LIFTED' | 'EXPIRED'): Promise<void> {
    await this.prisma.roomBan.update({
      where: { id },
      data: { status, liftedBy, liftedAt: new Date(), ...auditUpdate(liftedBy) },
    });
  }

  findExpiredBans(now: Date, take = 200): Promise<RoomBan[]> {
    return this.prisma.roomBan.findMany({
      where: { status: 'ACTIVE', expiresAt: { not: null, lt: now } },
      take,
      orderBy: { expiresAt: 'asc' },
    });
  }

  // ---- Mutes ----

  createMute(input: {
    roomId: string;
    userId: string;
    moderatorId: string;
    type: ModerationMuteType;
    reason: string | null;
    expiresAt: Date | null;
  }): Promise<RoomMute> {
    return this.prisma.roomMute.create({
      data: {
        roomId: input.roomId,
        userId: input.userId,
        moderatorId: input.moderatorId,
        type: input.type,
        reason: input.reason,
        expiresAt: input.expiresAt,
        ...auditCreate(input.moderatorId),
      },
    });
  }

  findActiveMute(roomId: string, userId: string): Promise<RoomMute | null> {
    return this.prisma.roomMute.findFirst({ where: { roomId, userId, status: 'ACTIVE' } });
  }

  getMute(id: string): Promise<RoomMute | null> {
    return this.prisma.roomMute.findUnique({ where: { id } });
  }

  listActiveMutes(roomId: string, skip: number, take: number): Promise<[RoomMute[], number]> {
    const where: Prisma.RoomMuteWhereInput = { roomId, status: 'ACTIVE' };
    return this.prisma.$transaction([
      this.prisma.roomMute.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.roomMute.count({ where }),
    ]);
  }

  async liftMute(id: string, liftedBy: string, status: 'LIFTED' | 'EXPIRED'): Promise<void> {
    await this.prisma.roomMute.update({
      where: { id },
      data: { status, liftedBy, liftedAt: new Date(), ...auditUpdate(liftedBy) },
    });
  }

  findExpiredMutes(now: Date, take = 200): Promise<RoomMute[]> {
    return this.prisma.roomMute.findMany({
      where: { status: 'ACTIVE', expiresAt: { not: null, lt: now } },
      take,
      orderBy: { expiresAt: 'asc' },
    });
  }

  // ---- Immutable moderation audit ----

  async appendAction(input: {
    roomId: string;
    moderatorId: string | null;
    targetUserId: string | null;
    action: ModerationActionType;
    reason?: string | null;
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.prisma.moderationAction.create({
      data: {
        roomId: input.roomId,
        moderatorId: input.moderatorId,
        targetUserId: input.targetUserId,
        action: input.action,
        reason: input.reason ?? null,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
  }

  listActions(
    roomId: string,
    skip: number,
    take: number,
    targetUserId?: string,
  ): Promise<[unknown[], number]> {
    const where: Prisma.ModerationActionWhereInput = {
      roomId,
      ...(targetUserId ? { targetUserId } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.moderationAction.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.moderationAction.count({ where }),
    ]);
  }

  // ---- Notes ----

  async addNote(input: {
    roomId: string;
    targetUserId: string;
    authorId: string;
    note: string;
  }): Promise<void> {
    await this.prisma.moderationNote.create({ data: input });
  }

  listNotes(
    roomId: string,
    skip: number,
    take: number,
    targetUserId?: string,
  ): Promise<[unknown[], number]> {
    const where: Prisma.ModerationNoteWhereInput = {
      roomId,
      ...(targetUserId ? { targetUserId } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.moderationNote.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.moderationNote.count({ where }),
    ]);
  }

  // ---- Reports ----

  createReport(input: {
    roomId: string;
    reporterId: string;
    targetUserId: string;
    reason: ReportReason;
    description: string | null;
  }): Promise<RoomReport> {
    return this.prisma.roomReport.create({
      data: { ...input, ...auditCreate(input.reporterId) },
    });
  }

  getReport(id: string): Promise<RoomReport | null> {
    return this.prisma.roomReport.findUnique({ where: { id } });
  }

  findOpenReport(
    roomId: string,
    reporterId: string,
    targetUserId: string,
  ): Promise<RoomReport | null> {
    return this.prisma.roomReport.findFirst({
      where: { roomId, reporterId, targetUserId, status: 'PENDING' },
    });
  }

  listReports(roomId: string, skip: number, take: number): Promise<[RoomReport[], number]> {
    const where: Prisma.RoomReportWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.roomReport.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.roomReport.count({ where }),
    ]);
  }

  async reviewReport(
    id: string,
    reviewerId: string,
    status: ReportStatus,
    resolutionAction: string | null,
  ): Promise<void> {
    await this.prisma.roomReport.update({
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

  // ---- Appeals ----

  createAppeal(input: {
    roomId: string;
    userId: string;
    banId: string | null;
    muteId: string | null;
    reason: string;
  }): Promise<RoomAppeal> {
    return this.prisma.roomAppeal.create({ data: { ...input, ...auditCreate(input.userId) } });
  }

  getAppeal(id: string): Promise<RoomAppeal | null> {
    return this.prisma.roomAppeal.findUnique({ where: { id } });
  }

  findPendingAppeal(input: { banId?: string; muteId?: string }): Promise<RoomAppeal | null> {
    return this.prisma.roomAppeal.findFirst({
      where: {
        status: 'PENDING',
        ...(input.banId ? { banId: input.banId } : {}),
        ...(input.muteId ? { muteId: input.muteId } : {}),
      },
    });
  }

  listAppeals(roomId: string, skip: number, take: number): Promise<[RoomAppeal[], number]> {
    const where: Prisma.RoomAppealWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.roomAppeal.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.roomAppeal.count({ where }),
    ]);
  }

  async resolveAppeal(
    id: string,
    reviewerId: string,
    approved: boolean,
    decisionNote: string | null,
  ): Promise<void> {
    await this.prisma.roomAppeal.update({
      where: { id },
      data: {
        status: approved ? 'APPROVED' : 'REJECTED',
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        decisionNote,
        ...auditUpdate(reviewerId),
      },
    });
  }

  // ---- User display data (batch-resolved for list views) ----

  /**
   * Resolves username + avatar key for the given users in two batched queries.
   * Used by the Kick List so a moderator sees who was kicked and who kicked them
   * without an N+1 lookup per row.
   */
  async resolveUserSummaries(userIds: string[]): Promise<Map<string, ModeratedUserSummary>> {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (ids.length === 0) return new Map();

    const [users, profiles] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, username: true },
      }),
      this.prisma.userProfile.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, avatarKey: true },
      }),
    ]);

    const avatarByUser = new Map(profiles.map((p) => [p.userId, p.avatarKey]));
    return new Map(
      users.map((u) => [u.id, { username: u.username, avatarKey: avatarByUser.get(u.id) ?? null }]),
    );
  }

  // ---- Redis enforcement caches (hot path) ----

  async addKickCache(roomId: string, userId: string): Promise<void> {
    await this.redis.sadd(roomKickSetKey(roomId), userId);
    await this.redis.set(roomKickKey(roomId, userId), '1');
  }

  async removeKickCache(roomId: string, userId: string): Promise<void> {
    await this.redis.srem(roomKickSetKey(roomId), userId);
    await this.redis.del(roomKickKey(roomId, userId));
  }

  async isKickedCached(roomId: string, userId: string): Promise<boolean> {
    return (await this.redis.sismember(roomKickSetKey(roomId), userId)) === 1;
  }

  async addBanCache(roomId: string, userId: string, ttlMs: number | null): Promise<void> {
    await this.redis.sadd(roomBanSetKey(roomId), userId);
    if (ttlMs && ttlMs > 0) {
      await this.redis.set(roomBanKey(roomId, userId), '1', 'PX', ttlMs);
    } else {
      await this.redis.set(roomBanKey(roomId, userId), '1');
    }
  }

  async removeBanCache(roomId: string, userId: string): Promise<void> {
    await this.redis.srem(roomBanSetKey(roomId), userId);
    await this.redis.del(roomBanKey(roomId, userId));
  }

  async isBannedCached(roomId: string, userId: string): Promise<boolean> {
    return (await this.redis.sismember(roomBanSetKey(roomId), userId)) === 1;
  }

  async addMuteCache(roomId: string, userId: string, ttlMs: number | null): Promise<void> {
    await this.redis.sadd(roomMuteSetKey(roomId), userId);
    if (ttlMs && ttlMs > 0) {
      await this.redis.set(roomMuteKey(roomId, userId), '1', 'PX', ttlMs);
    } else {
      await this.redis.set(roomMuteKey(roomId, userId), '1');
    }
  }

  async removeMuteCache(roomId: string, userId: string): Promise<void> {
    await this.redis.srem(roomMuteSetKey(roomId), userId);
    await this.redis.del(roomMuteKey(roomId, userId));
  }

  async isMutedCached(roomId: string, userId: string): Promise<boolean> {
    return (await this.redis.sismember(roomMuteSetKey(roomId), userId)) === 1;
  }
}
