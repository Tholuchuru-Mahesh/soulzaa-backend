import { Inject, Injectable } from '@nestjs/common';
import {
  LiveStreamBan,
  LiveStreamModerationBanType,
  LiveStreamModerationMuteType,
  LiveStreamModerationStatus,
  LiveStreamMute,
} from '@prisma/client';
import { auditCreate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import {
  liveStreamBanKey,
  liveStreamBanSetKey,
  liveStreamMuteKey,
  liveStreamMuteSetKey,
} from '../constants/live-stream-moderation.constants';

export interface CreateLiveStreamMuteInput {
  streamId: string;
  userId: string;
  moderatorId: string;
  type: LiveStreamModerationMuteType;
  reason?: string | null;
  expiresAt?: Date | null;
}

export interface CreateLiveStreamBanInput {
  streamId: string;
  userId: string;
  moderatorId: string;
  type: LiveStreamModerationBanType;
  reason?: string | null;
  expiresAt?: Date | null;
}

/**
 * Persistence for live-stream mute/ban enforcement: `live_stream_mutes` /
 * `live_stream_bans` (durable) mirrored into Redis SETs for the O(1)
 * chat-gate / join-gate reads. Mirrors VideoRoomModerationRepository's
 * mute/block pair — a live-stream KICK is transient (no row here, just the
 * socket disconnect the service issues directly), matching Video Room's own
 * kick/blacklist split.
 */
@Injectable()
export class LiveStreamModerationRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  // ---- Mutes ----

  async createMute(input: CreateLiveStreamMuteInput): Promise<LiveStreamMute> {
    return this.prisma.liveStreamMute.create({
      data: {
        streamId: input.streamId,
        userId: input.userId,
        moderatorId: input.moderatorId,
        type: input.type,
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
        ...auditCreate(input.moderatorId),
      },
    });
  }

  /** A user's current ACTIVE (non-expired) mute in a stream, or null. */
  async findActiveMute(streamId: string, userId: string): Promise<LiveStreamMute | null> {
    const now = new Date();
    return this.prisma.liveStreamMute.findFirst({
      where: {
        streamId,
        userId,
        status: LiveStreamModerationStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  }

  async addMuteMirror(streamId: string, userId: string, ttlMs?: number | null): Promise<void> {
    await this.redis.sadd(liveStreamMuteSetKey(streamId), userId);
    if (ttlMs && ttlMs > 0) {
      await this.redis.set(liveStreamMuteKey(streamId, userId), '1', 'PX', ttlMs);
    } else {
      await this.redis.set(liveStreamMuteKey(streamId, userId), '1');
    }
  }

  async isMutedMirror(streamId: string, userId: string): Promise<boolean> {
    return (await this.redis.sismember(liveStreamMuteSetKey(streamId), userId)) === 1;
  }

  /** O(1) mirror-accelerated check for the chat-send gate; falls through to the DB for the authoritative negative. */
  async isActivelyMuted(streamId: string, userId: string): Promise<boolean> {
    if (await this.isMutedMirror(streamId, userId)) return true;
    return !!(await this.findActiveMute(streamId, userId));
  }

  // ---- Bans ----

  async createBan(input: CreateLiveStreamBanInput): Promise<LiveStreamBan> {
    return this.prisma.liveStreamBan.create({
      data: {
        streamId: input.streamId,
        userId: input.userId,
        moderatorId: input.moderatorId,
        type: input.type,
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
        ...auditCreate(input.moderatorId),
      },
    });
  }

  /** A user's current ACTIVE (non-expired) ban in a stream, or null (the rejoin gate). */
  async findActiveBan(streamId: string, userId: string): Promise<LiveStreamBan | null> {
    const now = new Date();
    return this.prisma.liveStreamBan.findFirst({
      where: {
        streamId,
        userId,
        status: LiveStreamModerationStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  }

  async addBanMirror(streamId: string, userId: string, ttlMs?: number | null): Promise<void> {
    await this.redis.sadd(liveStreamBanSetKey(streamId), userId);
    if (ttlMs && ttlMs > 0) {
      await this.redis.set(liveStreamBanKey(streamId, userId), '1', 'PX', ttlMs);
    } else {
      await this.redis.set(liveStreamBanKey(streamId, userId), '1');
    }
  }

  async isBannedMirror(streamId: string, userId: string): Promise<boolean> {
    return (await this.redis.sismember(liveStreamBanSetKey(streamId), userId)) === 1;
  }

  /** O(1) mirror-accelerated check for the join gate; falls through to the DB for the authoritative negative. */
  async isActivelyBanned(streamId: string, userId: string): Promise<boolean> {
    if (await this.isBannedMirror(streamId, userId)) return true;
    return !!(await this.findActiveBan(streamId, userId));
  }
}
