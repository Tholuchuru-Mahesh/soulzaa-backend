import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import {
  Prisma,
  VideoRoom,
  VideoRoomCreationSource,
  VideoRoomLogAction,
  VideoRoomMember,
  VideoRoomMemberRole,
  VideoRoomMemberStatus,
  VideoRoomPresence,
  VideoRoomSettings,
  VideoRoomStatistics,
  VideoRoomStatus,
  VideoRoomStreamingStatus,
  VideoRoomVisibility,
} from '@prisma/client';
import { auditCreate, auditSoftDelete, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { buildSeatLayout } from '../constants/video-room-seat-lifecycle';
import {
  VIDEO_ROOM_DEFAULT_GUEST_SEATS,
  VIDEO_ROOM_DEFAULT_HOST_SEATS,
  VIDEO_ROOM_TRENDING_KEY,
  videoRoomCacheKey,
} from '../constants/video-room.constants';

/** Append-only audit entry input (write-once). */
export interface AppendLogInput {
  roomId: string;
  actorId: string | null;
  action: VideoRoomLogAction;
  metadata?: Prisma.InputJsonValue;
}

/** Durable presence-mirror upsert input. */
export interface UpsertPresenceInput {
  roomId: string;
  userId: string;
  socketId: string | null;
  role: VideoRoomMemberRole;
}

/** Create-or-reactivate a member row (VR-3 join). */
export interface UpsertActiveMemberInput {
  roomId: string;
  userId: string;
  role: VideoRoomMemberRole;
  deviceId?: string | null;
  platform?: string | null;
  actorId: string;
}

/** List/discovery query (already normalised by the caller). */
export interface ListRoomsParams {
  skip: number;
  take: number;
  discoverableOnly: boolean;
  status?: VideoRoomStatus;
}

/**
 * Faceted discovery/search query over the VR-1 columns (already normalised by the
 * caller). Every filter is backed by an index: categoryId / language / country /
 * (country,categoryId) B-trees and a GIN index on `tags` (array-contains). All
 * `tags` must be present (AND semantics).
 */
export interface SearchRoomsParams {
  skip: number;
  take: number;
  discoverableOnly: boolean;
  status?: VideoRoomStatus;
  categoryId?: string;
  language?: string;
  country?: string;
  tags?: string[];
  /** VR-2 discovery facets: featured (verified), vip (access policy), and "mine"/owner scoping. */
  isVerified?: boolean;
  accessPolicy?: string;
  ownerId?: string;
}

/** New-room persistence input (already validated + password-hashed by the service). */
export interface CreateVideoRoomData {
  ownerId: string;
  name: string;
  description: string | null;
  imageKey: string | null;
  categoryId: string | null;
  language: string | null;
  country: string | null;
  tags: string[];
  visibility: VideoRoomVisibility;
  isLocked: boolean;
  passwordHash: string | null;
  isDiscoverable: boolean;
  maxParticipants: number;
  maxViewers: number;
  creationSource: VideoRoomCreationSource;
  /** Optional metadata payload (e.g. { accessPolicy }); omitted → column stays null. */
  metadata?: Prisma.InputJsonValue;
  /** Snapshot of the owner's Region (`User.regionId`) at creation — powers
   *  moderator region-scoping. Null if the owner has no region assigned. */
  region: string | null;
}

/** Persistable subset of a room edit / lifecycle transition (nulls clear the column). */
export interface UpdateVideoRoomData {
  name?: string;
  description?: string | null;
  imageKey?: string | null;
  categoryId?: string | null;
  language?: string | null;
  country?: string | null;
  tags?: string[];
  visibility?: VideoRoomVisibility;
  isLocked?: boolean;
  passwordHash?: string | null;
  isDiscoverable?: boolean;
  maxParticipants?: number;
  maxViewers?: number;
  status?: VideoRoomStatus;
  streamingStatus?: VideoRoomStreamingStatus;
  endedAt?: Date | null;
  metadata?: Prisma.InputJsonValue;
}

/** The full read model for a room detail response (room + its 1:1 sibling rows). */
export interface VideoRoomDetail {
  room: VideoRoom;
  settings: VideoRoomSettings | null;
  statistics: VideoRoomStatistics | null;
}

/**
 * Data layer for the video-rooms domain (VR-0 foundation): Postgres reads,
 * lifecycle status transitions, the durable presence mirror, the immutable
 * room-log, plus the Redis room-snapshot cache. All Redis ops are single-key
 * (Cluster-safe). Business rules and live Redis presence live in the services;
 * this class is pure persistence. Room create/mutate persistence lands with the
 * lifecycle phase (its orchestration does not exist yet).
 */
@Injectable()
export class VideoRoomsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  // ---- Reads ----

  /** A room by id (excludes soft-deleted), or null. */
  async findById(id: string): Promise<VideoRoom | null> {
    return this.prisma.videoRoom.findFirst({ where: { id, deletedAt: null } });
  }

  async getOwnerRegionId(ownerId: string): Promise<string | null> {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { regionId: true },
    });
    return owner?.regionId ?? null;
  }

  /** All of an owner's non-deleted rooms, newest first. */
  async findByOwnerId(ownerId: string): Promise<VideoRoom[]> {
    return this.prisma.videoRoom.findMany({
      where: { ownerId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** A page of rooms for discovery/listing. */
  async list(params: ListRoomsParams): Promise<{ items: VideoRoom[]; total: number }> {
    const where: Prisma.VideoRoomWhereInput = {
      deletedAt: null,
      ...(params.discoverableOnly ? { isDiscoverable: true } : {}),
      ...(params.status ? { status: params.status } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.videoRoom.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.videoRoom.count({ where }),
    ]);
    return { items, total };
  }

  /** A faceted discovery page (category/language/country/tags), newest first. */
  async search(params: SearchRoomsParams): Promise<{ items: VideoRoom[]; total: number }> {
    const where: Prisma.VideoRoomWhereInput = {
      deletedAt: null,
      ...(params.discoverableOnly ? { isDiscoverable: true } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.categoryId ? { categoryId: params.categoryId } : {}),
      ...(params.language ? { language: params.language } : {}),
      ...(params.country ? { country: params.country } : {}),
      ...(params.tags && params.tags.length > 0 ? { tags: { hasEvery: params.tags } } : {}),
      ...(params.isVerified !== undefined ? { isVerified: params.isVerified } : {}),
      ...(params.ownerId ? { ownerId: params.ownerId } : {}),
      ...(params.accessPolicy
        ? { metadata: { path: ['accessPolicy'], equals: params.accessPolicy } }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.videoRoom.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.videoRoom.count({ where }),
    ]);
    return { items, total };
  }

  /** A soft-deleted room by id (for restore), or null. */
  async findDeletedById(id: string): Promise<VideoRoom | null> {
    return this.prisma.videoRoom.findFirst({ where: { id, deletedAt: { not: null } } });
  }

  /** A room by id regardless of soft-delete (verify-status reads deleted rooms too). */
  async findAnyById(id: string): Promise<VideoRoom | null> {
    return this.prisma.videoRoom.findUnique({ where: { id } });
  }

  /** Hydrate non-deleted rooms for a set of ids, preserving the caller's order. */
  async findManyByIds(ids: string[]): Promise<VideoRoom[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.videoRoom.findMany({
      where: { id: { in: ids }, deletedAt: null },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is VideoRoom => r !== undefined);
  }

  /** The full detail read model: room + its 1:1 settings + statistics rows. */
  async findDetail(id: string): Promise<VideoRoomDetail | null> {
    const room = await this.prisma.videoRoom.findFirst({ where: { id, deletedAt: null } });
    if (!room) return null;
    const [settings, statistics] = await this.prisma.$transaction([
      this.prisma.videoRoomSettings.findUnique({ where: { roomId: id } }),
      this.prisma.videoRoomStatistics.findUnique({ where: { roomId: id } }),
    ]);
    return { room, settings, statistics };
  }

  /** A room's settings row, or null when it has none (VR-8 seat queue policy lookup). */
  async getSettings(roomId: string): Promise<VideoRoomSettings | null> {
    return this.prisma.videoRoomSettings.findUnique({ where: { roomId } });
  }

  /**
   * `getSettings` for callers that cannot proceed without the row.
   *
   * The row is created transactionally with the room, so absence is a
   * data-integrity fault rather than a policy state. Guards that treated a
   * missing row as "allowed" opened every gate at once and silently; this
   * makes that condition loud instead.
   */
  async requireSettings(roomId: string): Promise<VideoRoomSettings> {
    const settings = await this.getSettings(roomId);
    if (!settings) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
        'Room settings are missing.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return settings;
  }

  /**
   * Patch a room's settings row (VR-9.1a chat-scoped slice today; the full
   * ~20-field surface lands with the settings phase). Callers build the
   * partial `data` themselves — this method has no business rules of its own.
   */
  async updateSettings(
    roomId: string,
    data: Prisma.VideoRoomSettingsUpdateInput,
  ): Promise<VideoRoomSettings> {
    return this.prisma.videoRoomSettings.update({ where: { roomId }, data });
  }

  /** Count an owner's non-deleted rooms (the "max rooms per owner" cap check). */
  countActiveByOwner(ownerId: string): Promise<number> {
    return this.prisma.videoRoom.count({ where: { ownerId, deletedAt: null } });
  }

  /**
   * "Popular" discovery: order by the denormalised statistics (peak viewers, then
   * lifetime joins), then hydrate the room rows preserving that order. Signals are
   * 0 until the join/viewer phase wires them — the ranking is correct-by-construction
   * and starts sorting meaningfully as soon as data flows.
   */
  async popular(params: {
    skip: number;
    take: number;
    discoverableOnly: boolean;
  }): Promise<{ items: VideoRoom[]; total: number }> {
    const stats = await this.prisma.videoRoomStatistics.findMany({
      orderBy: [{ peakViewers: 'desc' }, { totalJoins: 'desc' }],
      skip: params.skip,
      take: params.take,
      select: { roomId: true },
    });
    const ids = stats.map((s) => s.roomId);
    if (ids.length === 0) return { items: [], total: 0 };

    const where: Prisma.VideoRoomWhereInput = {
      id: { in: ids },
      deletedAt: null,
      ...(params.discoverableOnly ? { isDiscoverable: true } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.videoRoom.findMany({ where }),
      this.prisma.videoRoom.count({
        where: { deletedAt: null, ...(params.discoverableOnly ? { isDiscoverable: true } : {}) },
      }),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = ids.map((id) => byId.get(id)).filter((r): r is VideoRoom => r !== undefined);
    return { items, total };
  }

  // ---- Lifecycle status (recovery / cleanup primitive) ----

  /** Transition a room's status; stamps endedAt when moving to ENDED. */
  async updateStatus(id: string, status: VideoRoomStatus, actorId: string): Promise<VideoRoom> {
    return this.prisma.videoRoom.update({
      where: { id },
      data: {
        status,
        ...(status === VideoRoomStatus.ENDED ? { endedAt: new Date() } : {}),
        ...auditUpdate(actorId),
      },
    });
  }

  /** Lazily assign the room's ZEGO room handle on first media use (distinct from app id). */
  async setZegoRoomId(id: string, zegoRoomId: string, actorId: string): Promise<VideoRoom> {
    return this.prisma.videoRoom.update({
      where: { id },
      data: { zegoRoomId, ...auditUpdate(actorId) },
    });
  }

  /** Project the room-level streaming status (IDLE/PUBLISHING/PAUSED) from the media stage. */
  async setStreamingStatus(
    id: string,
    streamingStatus: VideoRoomStreamingStatus,
    actorId: string,
  ): Promise<VideoRoom> {
    return this.prisma.videoRoom.update({
      where: { id },
      data: { streamingStatus, ...auditUpdate(actorId) },
    });
  }

  // ---- VR-2 lifecycle writes ----

  /**
   * Create room + settings + statistics + owner member + authoritative OWNER grant
   * + the materialised seat layout + CREATED log in one transaction.
   *
   * Seat rows used to be deferred to "the seat phase", but nothing there ever
   * created them for a new room: `createLayout`'s only caller was the Settings →
   * Seats reconfigure screen. So every room shipped with settings declaring 10
   * seats and zero `video_room_seats` rows, and the seat stage — which projects
   * those rows, not the counts — came back empty, failing every seat claim with
   * SEAT_FULL. The layout is materialised here, inside the same transaction as the
   * settings row that declares it, so the two can never disagree. (Rooms created
   * before this fix self-heal on their next stage rebuild — see
   * `VideoRoomSeatStateService.rebuild`.)
   */
  async createRoomTx(data: CreateVideoRoomData): Promise<VideoRoom> {
    const seatLayout = buildSeatLayout(
      VIDEO_ROOM_DEFAULT_HOST_SEATS,
      VIDEO_ROOM_DEFAULT_GUEST_SEATS,
    );
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.videoRoom.create({
        data: {
          ownerId: data.ownerId,
          name: data.name,
          description: data.description,
          imageKey: data.imageKey,
          categoryId: data.categoryId,
          language: data.language,
          country: data.country,
          tags: data.tags,
          visibility: data.visibility,
          isLocked: data.isLocked,
          passwordHash: data.passwordHash,
          isDiscoverable: data.isDiscoverable,
          maxParticipants: data.maxParticipants,
          maxViewers: data.maxViewers,
          creationSource: data.creationSource,
          region: data.region,
          ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
          ...auditCreate(data.ownerId),
        },
      });
      // Written explicitly (rather than leaning on the schema defaults) so the
      // declared counts and the seat rows below come from one value.
      await tx.videoRoomSettings.create({
        data: {
          roomId: room.id,
          hostSeatCount: VIDEO_ROOM_DEFAULT_HOST_SEATS,
          guestSeatCount: VIDEO_ROOM_DEFAULT_GUEST_SEATS,
        },
      });
      await tx.videoRoomSeat.createMany({
        data: seatLayout.map((s) => ({
          roomId: room.id,
          seatIndex: s.seatIndex,
          seatType: s.seatType,
          ...auditCreate(data.ownerId),
        })),
        skipDuplicates: true,
      });
      await tx.videoRoomStatistics.create({ data: { roomId: room.id } });
      await tx.videoRoomMember.create({
        data: {
          roomId: room.id,
          userId: data.ownerId,
          role: VideoRoomMemberRole.OWNER,
          isActive: true,
          ...auditCreate(data.ownerId),
        },
      });
      await tx.videoRoomRole.create({
        data: {
          roomId: room.id,
          userId: data.ownerId,
          role: VideoRoomMemberRole.OWNER,
          grantedBy: data.ownerId,
          ...auditCreate(data.ownerId),
        },
      });
      await tx.videoRoomLog.create({
        data: { roomId: room.id, actorId: data.ownerId, action: VideoRoomLogAction.CREATED },
      });
      return room;
    });
  }

  /** Apply a validated field/lifecycle edit, stamping the actor. */
  updateRoom(id: string, data: UpdateVideoRoomData, actorId: string): Promise<VideoRoom> {
    return this.prisma.videoRoom.update({
      where: { id },
      data: { ...data, ...auditUpdate(actorId) },
    });
  }

  /** Soft-delete a room (history retained; findById already filters deletedAt). */
  softDelete(id: string, actorId: string): Promise<VideoRoom> {
    return this.prisma.videoRoom.update({
      where: { id },
      data: auditSoftDelete(actorId),
    });
  }

  /** Restore a soft-deleted room to a fresh OFFLINE (re-editable) state. */
  restore(id: string, actorId: string): Promise<VideoRoom> {
    return this.prisma.videoRoom.update({
      where: { id },
      data: {
        deletedAt: null,
        status: VideoRoomStatus.OFFLINE,
        endedAt: null,
        ...auditUpdate(actorId),
      },
    });
  }

  // ---- VR-2 trending sorted set (global discovery zset) ----

  /** Add `delta` to a room's trending score (seed on create/activate). */
  async trendingBump(roomId: string, delta = 1): Promise<void> {
    await this.cache.addScore(VIDEO_ROOM_TRENDING_KEY, roomId, delta);
  }

  /** Drop a room from the trending set (on close/delete). */
  async trendingRemove(roomId: string): Promise<void> {
    await this.cache.sortedRemove(VIDEO_ROOM_TRENDING_KEY, roomId);
  }

  /** The top `count` room ids by trending score, highest first. */
  async trendingTopIds(count: number): Promise<string[]> {
    const entries = await this.cache.top(VIDEO_ROOM_TRENDING_KEY, count);
    return entries.map((e) => e.member);
  }

  // ---- Immutable audit log (write-once) ----

  async appendLog(input: AppendLogInput): Promise<void> {
    await this.prisma.videoRoomLog.create({
      data: {
        roomId: input.roomId,
        actorId: input.actorId,
        action: input.action,
        metadata: input.metadata,
      },
    });
  }

  // ---- Durable presence mirror (recovery + expiry index) ----

  /** Upsert the durable presence row; refreshes lastSeenAt to now. */
  async upsertPresence(input: UpsertPresenceInput): Promise<void> {
    const now = new Date();
    await this.prisma.videoRoomPresence.upsert({
      where: { roomId_userId: { roomId: input.roomId, userId: input.userId } },
      create: {
        roomId: input.roomId,
        userId: input.userId,
        socketId: input.socketId,
        role: input.role,
      },
      update: { socketId: input.socketId, role: input.role, lastSeenAt: now },
    });
  }

  /** Slide a presence row's lastSeenAt forward (heartbeat). No-op if absent. */
  async touchPresence(roomId: string, userId: string): Promise<void> {
    await this.prisma.videoRoomPresence.updateMany({
      where: { roomId, userId },
      data: { lastSeenAt: new Date() },
    });
  }

  /** Remove a presence row (clean leave / eviction). */
  async removePresence(roomId: string, userId: string): Promise<void> {
    await this.prisma.videoRoomPresence.deleteMany({ where: { roomId, userId } });
  }

  /** Presence rows last seen before `cutoff` (the expiry sweep index). */
  async findStalePresence(cutoff: Date, limit: number): Promise<VideoRoomPresence[]> {
    return this.prisma.videoRoomPresence.findMany({
      where: { lastSeenAt: { lt: cutoff } },
      orderBy: { lastSeenAt: 'asc' },
      take: limit,
    });
  }

  // ---- VR-3 member lifecycle + live counters ----

  /** A member row (any status) for a (room,user), or null. */
  getMember(roomId: string, userId: string): Promise<VideoRoomMember | null> {
    return this.prisma.videoRoomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
  }

  /**
   * Create the member row, or reactivate a returning member's existing row
   * (unique on (roomId,userId) — never duplicated). Stamps join context + audit.
   */
  upsertActiveMember(input: UpsertActiveMemberInput): Promise<VideoRoomMember> {
    return this.prisma.videoRoomMember.upsert({
      where: { roomId_userId: { roomId: input.roomId, userId: input.userId } },
      create: {
        roomId: input.roomId,
        userId: input.userId,
        role: input.role,
        memberStatus: VideoRoomMemberStatus.ACTIVE,
        deviceId: input.deviceId ?? null,
        platform: input.platform ?? null,
        isActive: true,
        ...auditCreate(input.actorId),
      },
      update: {
        role: input.role,
        memberStatus: VideoRoomMemberStatus.ACTIVE,
        isActive: true,
        leftAt: null,
        lastActiveAt: new Date(),
        deviceId: input.deviceId ?? undefined,
        platform: input.platform ?? undefined,
        ...auditUpdate(input.actorId),
      },
    });
  }

  /** Deactivate a member (clean leave / reclaim): isActive=false, status LEFT, leftAt. */
  async deactivateMember(roomId: string, userId: string, actorId: string): Promise<void> {
    await this.prisma.videoRoomMember.updateMany({
      where: { roomId, userId, isActive: true },
      data: {
        isActive: false,
        memberStatus: VideoRoomMemberStatus.LEFT,
        leftAt: new Date(),
        ...auditUpdate(actorId),
      },
    });
  }

  /**
   * Move a room to a new owner (VR-7 ownership transfer / recovery). `ownerId` is
   * the single source of truth for ownership — there is no owner grant row — so
   * this one write is what makes the handover authoritative.
   */
  async setOwner(roomId: string, newOwnerId: string, actorId: string): Promise<void> {
    await this.prisma.videoRoom.update({
      where: { id: roomId },
      data: { ownerId: newOwnerId, ...auditUpdate(actorId) },
    });
  }

  /** Update a member's denormalised role mirror. */
  async setMemberRole(
    roomId: string,
    userId: string,
    role: VideoRoomMemberRole,
    actorId: string,
  ): Promise<void> {
    await this.prisma.videoRoomMember.updateMany({
      where: { roomId, userId },
      data: { role, ...auditUpdate(actorId) },
    });
  }

  /** A page of active members, oldest-join first (roster order). */
  listActiveMembers(roomId: string, take: number, skip: number): Promise<VideoRoomMember[]> {
    return this.prisma.videoRoomMember.findMany({
      where: { roomId, isActive: true },
      orderBy: { joinedAt: 'asc' },
      take,
      skip,
    });
  }

  /** Active member user-ids for a room (bounded by room capacity). */
  async listActiveMemberIds(roomId: string): Promise<string[]> {
    const rows = await this.prisma.videoRoomMember.findMany({
      where: { roomId, isActive: true },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** Count active members in a room. */
  countActiveMembers(roomId: string): Promise<number> {
    return this.prisma.videoRoomMember.count({ where: { roomId, isActive: true } });
  }

  /** A page of active member user-ids for a room, plus the total (fan-out cursor source). */
  async pageActiveMemberIds(
    roomId: string,
    skip: number,
    take: number,
  ): Promise<{ ids: string[]; total: number }> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.videoRoomMember.findMany({
        where: { roomId, isActive: true },
        orderBy: { joinedAt: 'asc' },
        select: { userId: true },
        skip,
        take,
      }),
      this.prisma.videoRoomMember.count({ where: { roomId, isActive: true } }),
    ]);
    return { ids: rows.map((r) => r.userId), total };
  }

  /** A page of active members excluding the given user ids (audience roster; seated users filtered at the query, so pages never under-fill). */
  listActiveMembersExcluding(
    roomId: string,
    excludeUserIds: string[],
    take: number,
    skip: number,
  ): Promise<VideoRoomMember[]> {
    return this.prisma.videoRoomMember.findMany({
      where: { roomId, isActive: true, userId: { notIn: excludeUserIds } },
      orderBy: { joinedAt: 'asc' },
      take,
      skip,
    });
  }

  /** Count active members excluding the given user ids. */
  countActiveMembersExcluding(roomId: string, excludeUserIds: string[]): Promise<number> {
    return this.prisma.videoRoomMember.count({
      where: { roomId, isActive: true, userId: { notIn: excludeUserIds } },
    });
  }

  /**
   * Join counters: bump lifetime totals + set the live viewer count, then raise
   * the peak if the live count is a new high (conditional updateMany, matching
   * the audio `bumpStatsOnJoin` pattern).
   */
  async bumpStatsOnJoin(roomId: string, liveCount: number): Promise<void> {
    await this.prisma.videoRoomStatistics.update({
      where: { roomId },
      data: {
        totalJoins: { increment: 1 },
        totalSessions: { increment: 1 },
        currentViewers: liveCount,
        lastActivityAt: new Date(),
      },
    });
    await this.prisma.videoRoomStatistics.updateMany({
      where: { roomId, peakViewers: { lt: liveCount } },
      data: { peakViewers: liveCount },
    });
  }

  /** Leave counters: set the live viewer count + activity timestamp. */
  async bumpStatsOnLeave(roomId: string, liveCount: number): Promise<void> {
    await this.prisma.videoRoomStatistics.update({
      where: { roomId },
      data: { currentViewers: liveCount, lastActivityAt: new Date() },
    });
  }

  /**
   * VR-9.1b: bump the lifetime chat message counter. Called from
   * `VideoRoomChatMetricsListener` off the send path, fire-and-forget — the
   * caller filters out SYSTEM rows so presence churn never inflates the count.
   */
  async bumpChatMessageCount(roomId: string): Promise<void> {
    await this.prisma.videoRoomStatistics.update({
      where: { roomId },
      data: { totalChatMessages: { increment: 1 }, lastActivityAt: new Date() },
    });
  }

  /**
   * Participant counters (VR-6 promote/demote): set the live participant count to
   * the authoritative occupied-seat count (never +/-1, to avoid concurrent drift)
   * and raise the peak if it is a new high.
   */
  async setParticipantStats(roomId: string, participantCount: number): Promise<void> {
    await this.prisma.videoRoomStatistics.update({
      where: { roomId },
      data: { currentParticipants: participantCount, lastActivityAt: new Date() },
    });
    await this.prisma.videoRoomStatistics.updateMany({
      where: { roomId, peakParticipants: { lt: participantCount } },
      data: { peakParticipants: participantCount },
    });
  }

  // ---- Redis read-snapshot cache ----

  async getCachedSnapshot<T>(roomId: string): Promise<T | null> {
    return this.cache.get<T>(videoRoomCacheKey(roomId));
  }

  async setCachedSnapshot<T>(roomId: string, value: T, ttlSeconds: number): Promise<void> {
    await this.cache.set(videoRoomCacheKey(roomId), value, ttlSeconds);
  }

  async clearCachedSnapshot(roomId: string): Promise<void> {
    await this.cache.del(videoRoomCacheKey(roomId));
  }
}
