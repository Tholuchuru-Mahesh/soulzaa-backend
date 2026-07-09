import { Inject, Injectable } from '@nestjs/common';
import {
  AudioRoom,
  Prisma,
  RoomCategory,
  RoomLanguage,
  RoomLogAction,
  RoomMember,
  RoomMemberRole,
  RoomVisibility,
} from '@prisma/client';
import { auditCreate, auditUpdate, auditSoftDelete } from 'src/common/utils/audit.util';
import { CacheService } from 'src/infra/redis/cache.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import {
  ROOM_TRENDING_KEY,
  buildSeatLayout,
  OWNER_SEAT_INDEX,
  roomCacheKey,
} from '../constants/audio-room.constants';
import type { RoomView } from '../interfaces/audio-rooms.service.interface';

/** Data to persist a brand-new room (already validated + password-hashed). */
export interface CreateRoomData {
  ownerId: string;
  name: string;
  description: string | null;
  imageKey: string | null;
  categoryId: string | null;
  language: string | null;
  visibility: RoomVisibility;
  isLocked: boolean;
  passwordHash: string | null;
  isDiscoverable: boolean;
  maxParticipants: number;
  agoraChannel: string;
  zegoRoomId: string;
  /** Initial stage layout (owner seat is always seat 0, added automatically). */
  speakerSeatCount: number;
  premiumAdminSeatCount: number;
  requireApprovalForSeat: boolean;
}

/** Persistable subset of an edit (nulls clear the column). */
export interface UpdateRoomData {
  name?: string;
  description?: string | null;
  imageKey?: string | null;
  categoryId?: string | null;
  language?: string | null;
  visibility?: RoomVisibility;
  isLocked?: boolean;
  passwordHash?: string | null;
  isDiscoverable?: boolean;
  maxParticipants?: number;
}

/**
 * Data layer for the audio-rooms domain: Postgres (rooms, members, settings,
 * statistics, presence, immutable logs, seeded categories/languages) plus the
 * Redis room-snapshot cache and the trending sorted set. All Redis ops are
 * single-key (Cluster-safe). Business rules and Redis presence live in the
 * service; this class is pure persistence.
 */
@Injectable()
export class AudioRoomsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  // ---- Rooms ----

  /**
   * Create room + settings + statistics + owner member + stage layout (owner
   * seat 0 occupied by the owner, plus premium/speaker seats) + the authoritative
   * OWNER room_roles grant, all in one transaction.
   */
  async createRoomTx(data: CreateRoomData): Promise<AudioRoom> {
    const layout = buildSeatLayout(data.premiumAdminSeatCount, data.speakerSeatCount);
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.audioRoom.create({
        data: {
          ownerId: data.ownerId,
          name: data.name,
          description: data.description,
          imageKey: data.imageKey,
          categoryId: data.categoryId,
          language: data.language,
          visibility: data.visibility,
          isLocked: data.isLocked,
          passwordHash: data.passwordHash,
          isDiscoverable: data.isDiscoverable,
          maxParticipants: data.maxParticipants,
          agoraChannel: data.agoraChannel,
          zegoRoomId: data.zegoRoomId,
          ...auditCreate(data.ownerId),
        },
      });
      await tx.roomSettings.create({
        data: {
          roomId: room.id,
          speakerSeatCount: data.speakerSeatCount,
          premiumAdminSeatCount: data.premiumAdminSeatCount,
          requireApprovalForSeat: data.requireApprovalForSeat,
        },
      });
      await tx.roomStatistics.create({ data: { roomId: room.id } });
      await tx.roomMember.create({
        data: {
          roomId: room.id,
          userId: data.ownerId,
          role: RoomMemberRole.OWNER,
          isActive: true,
          ...auditCreate(data.ownerId),
        },
      });
      await tx.roomRole.create({
        data: {
          roomId: room.id,
          userId: data.ownerId,
          role: RoomMemberRole.OWNER,
          grantedBy: data.ownerId,
          ...auditCreate(data.ownerId),
        },
      });
      await tx.roomSeat.createMany({
        data: layout.map((slot) => ({
          roomId: room.id,
          seatIndex: slot.seatIndex,
          seatType: slot.seatType,
          // The owner occupies seat 0 from creation.
          occupantUserId: slot.seatIndex === OWNER_SEAT_INDEX ? data.ownerId : null,
          ...auditCreate(data.ownerId),
        })),
      });
      await tx.roomLog.create({
        data: { roomId: room.id, actorId: data.ownerId, action: RoomLogAction.CREATED },
      });
      return room;
    });
  }

  /** A non-deleted room row (any status), or null. */
  findRoomRow(roomId: string): Promise<AudioRoom | null> {
    return this.prisma.audioRoom.findFirst({ where: { id: roomId, deletedAt: null } });
  }

  /** A LIVE, non-deleted room row, or null. */
  findLiveRoomRow(roomId: string): Promise<AudioRoom | null> {
    return this.prisma.audioRoom.findFirst({
      where: { id: roomId, deletedAt: null, status: 'LIVE' },
    });
  }

  /** Per-room settings row (allowChat, slow-mode, etc.), or null if missing. */
  getSettings(roomId: string) {
    return this.prisma.roomSettings.findUnique({ where: { roomId } });
  }

  async getOwnerId(roomId: string): Promise<string | null> {
    const room = await this.prisma.audioRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      select: { ownerId: true },
    });
    return room?.ownerId ?? null;
  }

  async getZegoRoomId(roomId: string): Promise<string | null> {
    const room = await this.prisma.audioRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      select: { zegoRoomId: true },
    });
    return room?.zegoRoomId ?? null;
  }

  /** Lazily assign a zego room id to a legacy (pre-voice) room. */
  async setZegoRoomId(roomId: string, zegoRoomId: string): Promise<void> {
    await this.prisma.audioRoom.update({ where: { id: roomId }, data: { zegoRoomId } });
  }

  countActiveRoomsOwnedBy(ownerId: string): Promise<number> {
    return this.prisma.audioRoom.count({
      where: { ownerId, deletedAt: null, status: 'LIVE' },
    });
  }

  /**
   * The caller's active (LIVE, non-deleted) owned room, or null. At most one row
   * exists — one standard room per user is enforced on create.
   */
  findOwnedLiveRoom(ownerId: string): Promise<AudioRoom | null> {
    return this.prisma.audioRoom.findFirst({
      where: { ownerId, deletedAt: null, status: 'LIVE' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listRooms(filter: {
    skip: number;
    take: number;
    categoryId?: string;
    language?: string;
    search?: string;
    visibility?: RoomVisibility;
    discoverableOnly: boolean;
  }): Promise<{ rows: AudioRoom[]; total: number }> {
    const where: Prisma.AudioRoomWhereInput = {
      deletedAt: null,
      status: 'LIVE',
      ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
      ...(filter.language ? { language: filter.language } : {}),
      ...(filter.visibility ? { visibility: filter.visibility } : {}),
      ...(filter.discoverableOnly
        ? { isDiscoverable: true, visibility: RoomVisibility.PUBLIC }
        : {}),
      ...(filter.search
        ? { name: { contains: filter.search, mode: Prisma.QueryMode.insensitive } }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.audioRoom.findMany({
        where,
        skip: filter.skip,
        take: filter.take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.audioRoom.count({ where }),
    ]);
    return { rows, total };
  }

  updateRoom(roomId: string, data: UpdateRoomData, actorId: string): Promise<AudioRoom> {
    return this.prisma.audioRoom.update({
      where: { id: roomId },
      data: { ...data, ...auditUpdate(actorId) },
    });
  }

  async softDeleteRoom(roomId: string, actorId: string): Promise<void> {
    await this.prisma.audioRoom.update({
      where: { id: roomId },
      data: { status: 'ENDED', endedAt: new Date(), ...auditSoftDelete(actorId) },
    });
  }

  /** Mark a room ENDED and finalise its statistics in one transaction. */
  async endRoom(roomId: string, actorId: string, durationSeconds: number): Promise<void> {
    const endedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.audioRoom.update({
        where: { id: roomId },
        data: { status: 'ENDED', endedAt, ...auditUpdate(actorId) },
      }),
      this.prisma.roomMember.updateMany({
        where: { roomId, isActive: true },
        data: { isActive: false, leftAt: endedAt, ...auditUpdate(actorId) },
      }),
      this.prisma.roomPresence.deleteMany({ where: { roomId } }),
      this.prisma.roomStatistics.update({
        where: { roomId },
        data: {
          currentParticipants: 0,
          totalDurationSeconds: BigInt(Math.max(0, Math.floor(durationSeconds))),
          lastActivityAt: endedAt,
        },
      }),
    ]);
  }

  setOwner(roomId: string, ownerId: string, actorId: string): Promise<AudioRoom> {
    return this.prisma.audioRoom.update({
      where: { id: roomId },
      data: { ownerId, ...auditUpdate(actorId) },
    });
  }

  // ---- Members ----

  getMember(roomId: string, userId: string): Promise<RoomMember | null> {
    return this.prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId } } });
  }

  /** Insert or reactivate a member (returning users keep their row). */
  async upsertActiveMember(
    roomId: string,
    userId: string,
    role: RoomMemberRole,
    actorId: string,
  ): Promise<RoomMember> {
    return this.prisma.roomMember.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId, role, isActive: true, ...auditCreate(actorId) },
      update: { isActive: true, leftAt: null, joinedAt: new Date(), ...auditUpdate(actorId) },
    });
  }

  async deactivateMember(roomId: string, userId: string, actorId: string): Promise<void> {
    await this.prisma.roomMember.updateMany({
      where: { roomId, userId, isActive: true },
      data: { isActive: false, leftAt: new Date(), ...auditUpdate(actorId) },
    });
  }

  async setMemberRole(
    roomId: string,
    userId: string,
    role: RoomMemberRole,
    actorId: string,
  ): Promise<void> {
    await this.prisma.roomMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { role, ...auditUpdate(actorId) },
    });
  }

  listActiveMembers(roomId: string): Promise<RoomMember[]> {
    return this.prisma.roomMember.findMany({
      where: { roomId, isActive: true },
      orderBy: { joinedAt: 'asc' },
    });
  }

  // ---- Presence (durable mirror; Redis is authoritative) ----

  async upsertPresence(roomId: string, userId: string, socketId?: string | null): Promise<void> {
    const now = new Date();
    await this.prisma.roomPresence.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId, socketId: socketId ?? null },
      update: { lastSeenAt: now, socketId: socketId ?? null },
    });
  }

  async removePresence(roomId: string, userId: string): Promise<void> {
    await this.prisma.roomPresence.deleteMany({ where: { roomId, userId } });
  }

  // ---- Statistics ----

  async bumpStatsOnJoin(roomId: string, liveCount: number): Promise<void> {
    await this.prisma.roomStatistics.update({
      where: { roomId },
      data: {
        totalJoins: { increment: 1 },
        currentParticipants: liveCount,
        lastActivityAt: new Date(),
      },
    });
    // peakParticipants = max(peak, liveCount) — Prisma has no GREATEST, do it explicitly.
    await this.prisma.roomStatistics.updateMany({
      where: { roomId, peakParticipants: { lt: liveCount } },
      data: { peakParticipants: liveCount },
    });
  }

  async bumpStatsOnLeave(roomId: string, liveCount: number): Promise<void> {
    await this.prisma.roomStatistics.update({
      where: { roomId },
      data: { currentParticipants: liveCount, lastActivityAt: new Date() },
    });
  }

  // ---- Immutable audit log ----

  async appendLog(
    roomId: string,
    actorId: string | null,
    action: RoomLogAction,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.roomLog.create({
      data: { roomId, actorId, action, ...(metadata !== undefined ? { metadata } : {}) },
    });
  }

  // ---- Reference data (seeded) ----

  listActiveCategories(): Promise<RoomCategory[]> {
    return this.prisma.roomCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async categoryExists(categoryId: string): Promise<boolean> {
    return (
      (await this.prisma.roomCategory.count({ where: { id: categoryId, isActive: true } })) > 0
    );
  }

  listActiveLanguages(): Promise<RoomLanguage[]> {
    return this.prisma.roomLanguage.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async languageExists(code: string): Promise<boolean> {
    return (await this.prisma.roomLanguage.count({ where: { code, isActive: true } })) > 0;
  }

  // ---- Redis snapshot cache ----

  getCachedSnapshot(roomId: string): Promise<RoomView | null> {
    return this.cache.get<RoomView>(roomCacheKey(roomId));
  }

  async setCachedSnapshot(room: RoomView, ttlSeconds: number): Promise<void> {
    await this.cache.set(roomCacheKey(room.id), room, ttlSeconds);
  }

  async invalidateSnapshot(roomId: string): Promise<void> {
    await this.cache.del(roomCacheKey(roomId));
  }

  // ---- Redis trending sorted set ----

  async trendingBump(roomId: string, delta = 1): Promise<void> {
    await this.cache.addScore(ROOM_TRENDING_KEY, roomId, delta);
  }

  async trendingRemove(roomId: string): Promise<void> {
    await this.redis.zrem(ROOM_TRENDING_KEY, roomId);
  }

  /** Top room ids by trending score, highest first. */
  async trendingTopIds(count: number): Promise<string[]> {
    const entries = await this.cache.top(ROOM_TRENDING_KEY, count);
    return entries.map((e) => e.member);
  }

  /** Fetch multiple LIVE rooms by id (preserves the given id order). */
  async findLiveRoomsByIds(ids: string[]): Promise<AudioRoom[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.audioRoom.findMany({
      where: { id: { in: ids }, deletedAt: null, status: 'LIVE' },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is AudioRoom => r !== undefined);
  }

  /**
   * Most-active LIVE rooms by durable statistics (trending fallback when the
   * Redis zset is cold). Ranks room_statistics by joins + recency, then hydrates
   * the discoverable LIVE rooms in that order (no cross-model relation exists,
   * so this is two queries by convention).
   */
  async listTopRoomsByStatistics(take: number): Promise<AudioRoom[]> {
    const stats = await this.prisma.roomStatistics.findMany({
      orderBy: [{ totalJoins: 'desc' }, { lastActivityAt: 'desc' }],
      // Over-fetch: some ranked rooms may be private/ended and get filtered out.
      take: take * 4,
      select: { roomId: true },
    });
    return this.findLiveRoomsByIds(stats.map((s) => s.roomId)).then((rooms) =>
      rooms
        .filter((r) => r.isDiscoverable && r.visibility === RoomVisibility.PUBLIC)
        .slice(0, take),
    );
  }
}
