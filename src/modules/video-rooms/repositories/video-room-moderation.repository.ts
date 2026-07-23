import { Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  VideoRoomBlock,
  VideoRoomModerationActionType,
  VideoRoomModerationMuteType,
  VideoRoomModerationStatus,
  VideoRoomMute,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { blocksMirrorKey, mutesMirrorKey } from '../constants/video-room-moderation.constants';

export interface CreateMuteInput {
  roomId: string;
  userId: string;
  moderatorId: string;
  type: VideoRoomModerationMuteType;
  reason?: string | null;
  expiresAt?: Date | null;
}

export interface CreateBlockInput {
  roomId: string;
  userId: string;
  moderatorId: string;
  reason?: string | null;
}

export interface AppendModerationActionInput {
  roomId: string;
  moderatorId: string | null;
  targetUserId: string | null;
  action: VideoRoomModerationActionType;
  reason?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Persistence for video-room moderation: `video_room_mutes`, `video_room_blocks`,
 * and the append-only `video_room_moderation_actions` audit. NO ban table — the
 * Video Room has no ban feature; a block is the durable "bar from this room until
 * lifted". "One ACTIVE mute/block per (room,user)" is enforced by the caller under
 * a lock (a partial-unique on an enum status is not expressed in Prisma). Live
 * enforcement sets are cached in Redis in later phases; these tables are the
 * durable record.
 */
@Injectable()
export class VideoRoomModerationRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  // ---- Mutes ----

  async createMute(input: CreateMuteInput): Promise<VideoRoomMute> {
    return this.prisma.videoRoomMute.create({
      data: {
        roomId: input.roomId,
        userId: input.userId,
        moderatorId: input.moderatorId,
        type: input.type,
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
        ...auditCreate(input.moderatorId),
      },
    });
  }

  /** A user's current ACTIVE mute in a room, or null. */
  async findActiveMute(roomId: string, userId: string): Promise<VideoRoomMute | null> {
    return this.prisma.videoRoomMute.findFirst({
      where: { roomId, userId, status: VideoRoomModerationStatus.ACTIVE },
    });
  }

  /** Lift a mute (manual unmute). */
  async liftMute(id: string, liftedBy: string): Promise<VideoRoomMute> {
    return this.prisma.videoRoomMute.update({
      where: { id },
      data: {
        status: VideoRoomModerationStatus.LIFTED,
        liftedBy,
        liftedAt: new Date(),
        ...auditUpdate(liftedBy),
      },
    });
  }

  /** Bulk-expire ACTIVE temporary mutes past their `expiresAt`. Returns the count. */
  async expireMutes(now: Date): Promise<number> {
    const { count } = await this.prisma.videoRoomMute.updateMany({
      where: { status: VideoRoomModerationStatus.ACTIVE, expiresAt: { lt: now } },
      data: { status: VideoRoomModerationStatus.EXPIRED },
    });
    return count;
  }

  /**
   * ACTIVE mutes past their `expiresAt`, oldest-expiring first, capped so a
   * large backlog degrades gracefully instead of stalling a sweep tick.
   * Feeds `VideoRoomModerationExpiryMonitor`'s lift loop (each row is lifted
   * individually so its mirror/audit/event side effects fire per mute).
   * Mirrors the Audio Room `ModerationRepository.findExpiredMutes`.
   */
  findExpiredMutes(now: Date, take = 200): Promise<VideoRoomMute[]> {
    return this.prisma.videoRoomMute.findMany({
      where: { status: VideoRoomModerationStatus.ACTIVE, expiresAt: { not: null, lt: now } },
      take,
      orderBy: { expiresAt: 'asc' },
    });
  }

  /**
   * Active mutes in a room, paginated (the room's mute list). Optionally
   * scoped to a single `userId`. Mirrors `listActiveBlocks` and the Audio
   * Room `listActiveMutes` tuple `$transaction([findMany, count])` pattern.
   */
  listActiveMutes(
    roomId: string,
    skip: number,
    take: number,
    userId?: string,
  ): Promise<[VideoRoomMute[], number]> {
    const where: Prisma.VideoRoomMuteWhereInput = {
      roomId,
      status: VideoRoomModerationStatus.ACTIVE,
      ...(userId ? { userId } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.videoRoomMute.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.videoRoomMute.count({ where }),
    ]);
  }

  // ---- Blocks ----

  async createBlock(input: CreateBlockInput): Promise<VideoRoomBlock> {
    return this.prisma.videoRoomBlock.create({
      data: {
        roomId: input.roomId,
        userId: input.userId,
        moderatorId: input.moderatorId,
        reason: input.reason ?? null,
        ...auditCreate(input.moderatorId),
      },
    });
  }

  /** A user's current ACTIVE block in a room, or null (the join-time gate). */
  async findActiveBlock(roomId: string, userId: string): Promise<VideoRoomBlock | null> {
    return this.prisma.videoRoomBlock.findFirst({
      where: { roomId, userId, status: VideoRoomModerationStatus.ACTIVE },
    });
  }

  /**
   * Active blocks in a room (the room's blocklist), paginated. Optionally
   * scoped to a single `userId` (the read-model's per-user lookup case).
   */
  listActiveBlocks(
    roomId: string,
    skip: number,
    take: number,
    userId?: string,
  ): Promise<[VideoRoomBlock[], number]> {
    const where: Prisma.VideoRoomBlockWhereInput = {
      roomId,
      status: VideoRoomModerationStatus.ACTIVE,
      ...(userId ? { userId } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.videoRoomBlock.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.videoRoomBlock.count({ where }),
    ]);
  }

  /** Lift a block (restore the user). */
  async liftBlock(id: string, liftedBy: string): Promise<VideoRoomBlock> {
    return this.prisma.videoRoomBlock.update({
      where: { id },
      data: {
        status: VideoRoomModerationStatus.LIFTED,
        liftedBy,
        liftedAt: new Date(),
        ...auditUpdate(liftedBy),
      },
    });
  }

  // ---- Append-only audit ----

  async appendAction(input: AppendModerationActionInput): Promise<void> {
    await this.prisma.videoRoomModerationAction.create({
      data: {
        roomId: input.roomId,
        moderatorId: input.moderatorId,
        targetUserId: input.targetUserId,
        action: input.action,
        reason: input.reason ?? null,
        metadata: input.metadata,
      },
    });
  }

  /**
   * Moderation actions in a room (compliance review), paginated. Optionally
   * scoped to a single `targetUserId`. Mirrors `listActiveMutes`/
   * `listActiveBlocks` and the Audio Room `listActions` tuple pattern.
   */
  listActions(
    roomId: string,
    skip: number,
    take: number,
    targetUserId?: string,
  ): Promise<[Prisma.VideoRoomModerationActionGetPayload<object>[], number]> {
    const where: Prisma.VideoRoomModerationActionWhereInput = {
      roomId,
      ...(targetUserId ? { targetUserId } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.videoRoomModerationAction.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.videoRoomModerationAction.count({ where }),
    ]);
  }

  // ---- Redis enforcement mirrors (hot path) ----
  //
  // The DB (video_room_mutes / video_room_blocks) is authoritative; these SET
  // mirrors give O(1) enforcement checks (join gate / chat gate) without a
  // Prisma round-trip. Mirrors `moderation.repository.ts`'s
  // addMuteCache/removeMuteCache/isMutedCached triad (Audio Room), adapted to
  // this module's `mutesMirrorKey`/`blocksMirrorKey` builders. A per-user key
  // alongside the SET carries the optional PX ttl so temporary mutes/blocks
  // self-expire; the SET membership itself is only cleared by an explicit
  // remove (a later reconciliation sweep clears stale SET members whose
  // per-user key has lapsed).

  async addMuteMirror(roomId: string, userId: string, ttlMs?: number | null): Promise<void> {
    await this.redis.sadd(mutesMirrorKey(roomId), userId);
    if (ttlMs && ttlMs > 0) {
      await this.redis.set(this.muteMirrorUserKey(roomId, userId), '1', 'PX', ttlMs);
    } else {
      await this.redis.set(this.muteMirrorUserKey(roomId, userId), '1');
    }
  }

  async removeMuteMirror(roomId: string, userId: string): Promise<void> {
    await this.redis.srem(mutesMirrorKey(roomId), userId);
    await this.redis.del(this.muteMirrorUserKey(roomId, userId));
  }

  async isMutedMirror(roomId: string, userId: string): Promise<boolean> {
    return (await this.redis.sismember(mutesMirrorKey(roomId), userId)) === 1;
  }

  async addBlockMirror(roomId: string, userId: string, ttlMs?: number | null): Promise<void> {
    await this.redis.sadd(blocksMirrorKey(roomId), userId);
    if (ttlMs && ttlMs > 0) {
      await this.redis.set(this.blockMirrorUserKey(roomId, userId), '1', 'PX', ttlMs);
    } else {
      await this.redis.set(this.blockMirrorUserKey(roomId, userId), '1');
    }
  }

  async removeBlockMirror(roomId: string, userId: string): Promise<void> {
    await this.redis.srem(blocksMirrorKey(roomId), userId);
    await this.redis.del(this.blockMirrorUserKey(roomId, userId));
  }

  async isBlockedMirror(roomId: string, userId: string): Promise<boolean> {
    return (await this.redis.sismember(blocksMirrorKey(roomId), userId)) === 1;
  }

  // ---- Positive-only fast-path guards (I4 fix) ----
  //
  // The DB stays authoritative. A mirror HIT means "definitely active" so we
  // return `true` immediately and skip the Prisma round-trip; a mirror MISS
  // is NOT trusted as "not active" on its own (the mirror can lag/never have
  // been populated for a row written before this fix, or by a path that
  // doesn't yet maintain it) — it falls through to the DB find, which is
  // authoritative for the negative case.

  /** O(1) mirror-accelerated existence check for an active block. */
  async isActivelyBlocked(roomId: string, userId: string): Promise<boolean> {
    if (await this.isBlockedMirror(roomId, userId)) {
      return true;
    }
    return !!(await this.findActiveBlock(roomId, userId));
  }

  /** O(1) mirror-accelerated existence check for an active mute. */
  async isActivelyMuted(roomId: string, userId: string): Promise<boolean> {
    if (await this.isMutedMirror(roomId, userId)) {
      return true;
    }
    return !!(await this.findActiveMute(roomId, userId));
  }

  private muteMirrorUserKey(roomId: string, userId: string): string {
    return `${mutesMirrorKey(roomId)}:${userId}`;
  }

  private blockMirrorUserKey(roomId: string, userId: string): string {
    return `${blocksMirrorKey(roomId)}:${userId}`;
  }
}
