import { Inject, Injectable } from '@nestjs/common';
import { DevicePlatform, Prisma, SessionEventType, UserSession } from '@prisma/client';
import { CacheService } from 'src/infra/redis/cache.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';

/** Live session blob cached under `session:{sid}` (drives revoke + inactivity). */
export interface SessionCacheBlob {
  userId: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  platform: DevicePlatform | null;
  trusted: boolean;
}

/**
 * Data layer for the session module: Postgres (`user_sessions`, `user_devices`,
 * `session_history`) plus the Redis live-session cache (`session:{sid}` via
 * CacheService's session helpers) and the per-user active-session index
 * (`user_sessions:{userId}` SET via the raw client). The set key is hash-tagged
 * (`{userId}`) so it stays on one slot in Cluster mode — mirrors PresenceService.
 */
@Injectable()
export class SessionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  // ---- user_sessions (Postgres) ----

  createSession(input: {
    id: string;
    userId: string;
    deviceId?: string | null;
    platform?: DevicePlatform | null;
    refreshTokenHash: string;
    expiresAt: Date;
    createdByIp?: string | null;
    userAgent?: string | null;
  }): Promise<UserSession> {
    return this.prisma.userSession.create({
      data: {
        id: input.id,
        userId: input.userId,
        deviceId: input.deviceId ?? null,
        platform: input.platform ?? null,
        refreshTokenHash: input.refreshTokenHash,
        expiresAt: input.expiresAt,
        createdByIp: input.createdByIp ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  getSession(id: string): Promise<UserSession | null> {
    return this.prisma.userSession.findUnique({ where: { id } });
  }

  listActiveSessions(userId: string): Promise<UserSession[]> {
    return this.prisma.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
    });
  }

  countActiveSessions(userId: string): Promise<number> {
    return this.prisma.userSession.count({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  markSessionRotated(id: string, replacedBySessionId: string): Promise<UserSession> {
    return this.prisma.userSession.update({
      where: { id },
      data: { revokedAt: new Date(), replacedBySessionId, lastActivityAt: new Date() },
    });
  }

  touchActivity(id: string): Promise<Prisma.BatchPayload> {
    return this.prisma.userSession.updateMany({
      where: { id },
      data: { lastActivityAt: new Date() },
    });
  }

  revokeSession(id: string): Promise<Prisma.BatchPayload> {
    return this.prisma.userSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  revokeAllSessions(userId: string): Promise<Prisma.BatchPayload> {
    return this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ---- session_history (Postgres, append-only) ----

  recordEvent(input: {
    sessionId?: string | null;
    userId: string;
    event: SessionEventType;
    ip?: string | null;
    userAgent?: string | null;
    /** Derived browser/OS/device/country. Optional — callers without it still record. */
    telemetry?: {
      browser?: string | null;
      os?: string | null;
      deviceType?: string | null;
      country?: string | null;
    };
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    return this.prisma.sessionHistory
      .create({
        data: {
          sessionId: input.sessionId ?? null,
          userId: input.userId,
          event: input.event,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          browser: input.telemetry?.browser ?? null,
          os: input.telemetry?.os ?? null,
          deviceType: input.telemetry?.deviceType ?? null,
          country: input.telemetry?.country ?? null,
          metadata: input.metadata,
        },
      })
      .then(() => undefined);
  }

  // ---- Redis: live session blob (session:{sid}) ----

  cacheSession(sessionId: string, blob: SessionCacheBlob, ttlSeconds: number): Promise<void> {
    return this.cache.setSession(sessionId, blob, ttlSeconds);
  }

  getCachedSession(sessionId: string): Promise<SessionCacheBlob | null> {
    return this.cache.getSession<SessionCacheBlob>(sessionId);
  }

  destroyCachedSession(sessionId: string): Promise<void> {
    return this.cache.destroySession(sessionId);
  }

  // ---- Redis: per-user active-session index (user_sessions:{userId}) ----

  private userSetKey(userId: string): string {
    return `user_sessions:{${userId}}`;
  }

  async addToUserIndex(userId: string, sessionId: string): Promise<void> {
    await this.redis.sadd(this.userSetKey(userId), sessionId);
  }

  async removeFromUserIndex(userId: string, sessionId: string): Promise<void> {
    await this.redis.srem(this.userSetKey(userId), sessionId);
  }

  userIndexMembers(userId: string): Promise<string[]> {
    return this.redis.smembers(this.userSetKey(userId));
  }

  async clearUserIndex(userId: string): Promise<void> {
    await this.redis.del(this.userSetKey(userId));
  }
}
