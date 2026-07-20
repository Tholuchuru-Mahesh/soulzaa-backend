import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomMemberRole, VideoRoomPresence } from '@prisma/client';
import { CacheService } from 'src/infra/redis/cache.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { loadVideoRoomConfig } from '../config/video-room.config';
import {
  VIDEO_ROOM_SOCKET_EVENTS,
  videoRoomSessionKey,
  videoRoomSessionsKey,
  videoRoomUserSessionsKey,
} from '../constants/video-room.constants';
import { ConnectionType, VideoRoomPresenceState } from '../enums';
import type {
  HeartbeatInput,
  IRoomSessionManager,
  RegisterSessionInput,
  RegisterSessionResult,
  VideoRoomSessionRecord,
} from '../interfaces/room-session-manager.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import { VideoRoomEventService } from './video-room-event.service';

/** How many stale sessions a single expiry sweep reclaims per tick. */
const EXPIRE_BATCH_LIMIT = 500;

/**
 * Per-connection session manager (VR-0 foundation primitive, wired live in VR-3):
 * the socket/session registry, heartbeat refresh, per-device duplicate eviction,
 * clean end, and expiry of sessions whose client dropped without a leave.
 *
 * Redis is authoritative: the hot per-socket session record (TTL-scoped), the
 * room's live session set, and a per-user reverse index. The durable
 * `video_room_presence` mirror is written LAZILY (not every beat) — it exists for
 * cross-instance recovery + the expiry-sweep index, so a bounded lag behind the
 * live Redis state is acceptable and keeps 1M-user heartbeat traffic off Postgres.
 */
@Injectable()
export class VideoRoomSessionService implements IRoomSessionManager {
  private readonly logger = new Logger(VideoRoomSessionService.name);
  private readonly sessionTtl: number;
  /** Min gap between durable-mirror flushes for a heartbeating session (ms). */
  private readonly mirrorFlushMs: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly cache: CacheService,
    private readonly repo: VideoRoomsRepository,
    private readonly sockets: SocketManager,
    private readonly events: VideoRoomEventService,
    private readonly metrics: VideoRoomsMetrics,
    config: ConfigService,
  ) {
    const cfg = loadVideoRoomConfig(config);
    this.sessionTtl = cfg.sessionTtlSeconds;
    // Flush the durable mirror at most ~once per two heartbeat intervals — well
    // inside the reconnect grace window, so a live session is never falsely reclaimed.
    this.mirrorFlushMs = cfg.heartbeatIntervalSeconds * 2 * 1000;
  }

  async register(input: RegisterSessionInput): Promise<RegisterSessionResult> {
    const duplicateOf = await this.findDuplicateDevice(
      input.userId,
      input.deviceId,
      input.socketId,
    );

    // Evict the stale same-device session BEFORE writing the new one, so the
    // durable presence mirror (unique per room+user) ends up reflecting the new
    // session — including the room-switch case where the old room's row is dropped.
    if (duplicateOf) await this.evict(duplicateOf);

    const now = new Date().toISOString();
    const session: VideoRoomSessionRecord = {
      roomId: input.roomId,
      userId: input.userId,
      socketId: input.socketId,
      role: input.role,
      deviceId: input.deviceId,
      platform: input.platform,
      ip: input.ip,
      sid: input.sid,
      presenceState: VideoRoomPresenceState.CONNECTING,
      inBackground: false,
      connectedAt: now,
      lastSeenAt: now,
      lastMirrorAt: now,
      reconnectCount: 0,
    };

    await this.cache.set(videoRoomSessionKey(input.socketId), session, this.sessionTtl);
    await this.redis.sadd(videoRoomSessionsKey(input.roomId), input.socketId);
    await this.redis.sadd(videoRoomUserSessionsKey(input.userId), input.socketId);
    await this.repo.upsertPresence({
      roomId: input.roomId,
      userId: input.userId,
      socketId: input.socketId,
      role: this.toMemberRole(input.role),
    });

    return { session, duplicateOf };
  }

  async heartbeat(socketId: string, input?: HeartbeatInput): Promise<boolean> {
    const record = await this.getSession(socketId);
    if (!record) {
      this.metrics.incHeartbeatFailure();
      return false;
    }
    const now = Date.now();
    const inBackground = input?.inBackground ?? record.inBackground;
    // A heartbeat means "alive" — ONLINE, or IDLE when the client is backgrounded.
    // The staleness-based states (RECONNECTING/LEFT) are computed at read time by
    // derivePresenceState; the sticky DISCONNECTED/LEFT are cleared only by the
    // reconnect/leave flows, not by a stray beat.
    const flushDue =
      Number.isNaN(Date.parse(record.lastMirrorAt)) ||
      now - Date.parse(record.lastMirrorAt) >= this.mirrorFlushMs;
    const next: VideoRoomSessionRecord = {
      ...record,
      inBackground,
      presenceState: inBackground ? VideoRoomPresenceState.IDLE : VideoRoomPresenceState.ONLINE,
      lastSeenAt: new Date(now).toISOString(),
      lastMirrorAt: flushDue ? new Date(now).toISOString() : record.lastMirrorAt,
    };
    await this.cache.set(videoRoomSessionKey(socketId), next, this.sessionTtl);
    // Lazy durable write: only touch Postgres when the mirror is due, not per beat.
    if (flushDue) await this.repo.touchPresence(record.roomId, record.userId);
    return true;
  }

  async getSession(socketId: string): Promise<VideoRoomSessionRecord | null> {
    return this.cache.get<VideoRoomSessionRecord>(videoRoomSessionKey(socketId));
  }

  async listRoomSessions(roomId: string): Promise<string[]> {
    return this.redis.smembers(videoRoomSessionsKey(roomId));
  }

  /** Count of live sessions (sockets) in a room — O(1) SCARD. */
  async roomSessionCount(roomId: string): Promise<number> {
    return this.redis.scard(videoRoomSessionsKey(roomId));
  }

  async listUserSessions(userId: string): Promise<string[]> {
    return this.redis.smembers(videoRoomUserSessionsKey(userId));
  }

  async end(socketId: string): Promise<VideoRoomSessionRecord | null> {
    const record = await this.getSession(socketId);
    await this.cache.del(videoRoomSessionKey(socketId));
    if (!record) return null;
    await this.redis.srem(videoRoomSessionsKey(record.roomId), socketId);
    await this.redis.srem(videoRoomUserSessionsKey(record.userId), socketId);
    await this.repo.removePresence(record.roomId, record.userId);
    return record;
  }

  async endUserRoomSessions(roomId: string, userId: string): Promise<VideoRoomSessionRecord[]> {
    const socketIds = await this.listUserSessions(userId);
    const ended: VideoRoomSessionRecord[] = [];
    for (const socketId of socketIds) {
      const record = await this.getSession(socketId);
      if (record?.roomId !== roomId) continue;
      const done = await this.end(socketId);
      if (done) ended.push(done);
    }
    return ended;
  }

  /**
   * Promote a freshly re-registered socket back to ONLINE and carry the reconnect
   * count forward from the previous socket (if the client supplied it).
   */
  async touchReconnect(
    socketId: string,
    previousSocketId?: string,
  ): Promise<VideoRoomSessionRecord | null> {
    const record = await this.getSession(socketId);
    if (!record) return null;
    const prev = previousSocketId ? await this.getSession(previousSocketId) : null;
    const carried = (prev?.reconnectCount ?? record.reconnectCount) + 1;
    const next: VideoRoomSessionRecord = {
      ...record,
      presenceState: VideoRoomPresenceState.ONLINE,
      reconnectCount: carried,
      lastSeenAt: new Date().toISOString(),
    };
    await this.cache.set(videoRoomSessionKey(socketId), next, this.sessionTtl);
    return next;
  }

  async markPresence(
    socketId: string,
    state: VideoRoomPresenceState,
  ): Promise<VideoRoomSessionRecord | null> {
    const record = await this.getSession(socketId);
    if (!record) return null;
    // Only the presence state changes — lastSeenAt is NOT slid, so the grace
    // countdown (driven by the durable lastSeenAt) keeps running toward reclaim.
    const next: VideoRoomSessionRecord = { ...record, presenceState: state };
    await this.cache.set(videoRoomSessionKey(socketId), next, this.sessionTtl);
    return next;
  }

  async expireStale(cutoff: Date): Promise<VideoRoomPresence[]> {
    const stale = await this.repo.findStalePresence(cutoff, EXPIRE_BATCH_LIMIT);
    const reclaimed: VideoRoomPresence[] = [];
    for (const row of stale) {
      try {
        if (row.socketId) {
          await this.cache.del(videoRoomSessionKey(row.socketId));
          await this.redis.srem(videoRoomSessionsKey(row.roomId), row.socketId);
          await this.redis.srem(videoRoomUserSessionsKey(row.userId), row.socketId);
        }
        await this.repo.removePresence(row.roomId, row.userId);
        reclaimed.push(row);
      } catch (err) {
        this.logger.warn(
          `Failed to expire stale session ${row.roomId}/${row.userId}: ${(err as Error).message}`,
        );
      }
    }
    if (reclaimed.length > 0) {
      this.logger.debug(`Expired ${reclaimed.length} stale video-room session(s)`);
    }
    return reclaimed;
  }

  /**
   * Tear down a superseded same-device session and tell that socket to drop. The
   * evicted client learns of it two ways (cross-instance safe): a point-to-point
   * `session_evicted` push, and its next heartbeat returning false (record gone).
   */
  private async evict(socketId: string): Promise<void> {
    const old = await this.end(socketId);
    if (!old) return;
    this.sockets.emitToUserEverywhere(old.userId, VIDEO_ROOM_SOCKET_EVENTS.SESSION_EVICTED, {
      roomId: old.roomId,
      evictedSocketId: old.socketId,
    });
    await this.events.emitUserDisconnected({
      roomId: old.roomId,
      userId: old.userId,
      socketId: old.socketId,
      reason: 'duplicate_session',
    });
    this.metrics.incDuplicateSession();
  }

  /**
   * A live socket for the same (user, device) other than `selfSocketId`, via the
   * per-user reverse index. Null when there is no device id (cannot dedup) or no
   * matching device session.
   */
  private async findDuplicateDevice(
    userId: string,
    deviceId: string | undefined,
    selfSocketId: string,
  ): Promise<string | null> {
    if (!deviceId) return null;
    const sockets = await this.listUserSessions(userId);
    for (const socketId of sockets) {
      if (socketId === selfSocketId) continue;
      const record = await this.getSession(socketId);
      if (record && record.deviceId === deviceId) return socketId;
    }
    return null;
  }

  private toMemberRole(role: ConnectionType): VideoRoomMemberRole {
    return role === ConnectionType.PUBLISHER
      ? VideoRoomMemberRole.PARTICIPANT
      : VideoRoomMemberRole.VIEWER;
  }
}
