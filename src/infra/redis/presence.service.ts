import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from './redis.constants';

/**
 * Realtime presence backed by Redis sets so every API instance sees the same
 * view: who is online, which sockets a user holds, and who is in each room.
 *
 * Keys use `{hash-tags}` so a room's (or user's) related keys hash to the same
 * Cluster slot. Each method still issues single-key commands — no cross-slot
 * multi-key op — so this is Cluster-safe. Presence is inherently eventually
 * consistent: connect/disconnect are a short sequence of commands, not a
 * transaction, which is the right trade-off for socket churn.
 */
@Injectable()
export class PresenceService {
  private static readonly ONLINE_KEY = 'presence:online';

  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisClient) {}

  private userSocketsKey(userId: string): string {
    return `presence:user:{${userId}}:sockets`;
  }

  private userRoomsKey(userId: string): string {
    return `presence:user:{${userId}}:rooms`;
  }

  private roomMembersKey(roomId: string): string {
    return `presence:room:{${roomId}}:members`;
  }

  private roomModeratorsKey(roomId: string): string {
    return `presence:room:{${roomId}}:moderators`;
  }

  // ---- Connections / online users ----

  /**
   * Register a socket for a user. Returns true when this is the user's first
   * live socket (i.e. they just came online) so callers can emit a presence event.
   */
  async connect(userId: string, socketId: string): Promise<boolean> {
    await this.client.sadd(this.userSocketsKey(userId), socketId);
    await this.client.expire(this.userSocketsKey(userId), 86400); // 24 hours TTL
    const liveSockets = await this.client.scard(this.userSocketsKey(userId));
    if (liveSockets === 1) {
      await this.client.sadd(PresenceService.ONLINE_KEY, userId);
      return true;
    }
    return false;
  }

  /**
   * Deregister a socket. Returns true when it was the user's last socket (they
   * just went offline).
   */
  async disconnect(userId: string, socketId: string): Promise<boolean> {
    await this.client.srem(this.userSocketsKey(userId), socketId);
    const liveSockets = await this.client.scard(this.userSocketsKey(userId));
    if (liveSockets === 0) {
      await this.client.del(this.userSocketsKey(userId));
      await this.client.del(this.userRoomsKey(userId));
      await this.client.srem(PresenceService.ONLINE_KEY, userId);
      return true;
    } else {
      await this.client.expire(this.userSocketsKey(userId), 86400);
    }
    return false;
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.client.sismember(PresenceService.ONLINE_KEY, userId)) === 1;
  }

  async onlineUsers(): Promise<string[]> {
    return this.client.smembers(PresenceService.ONLINE_KEY);
  }

  async onlineCount(): Promise<number> {
    return this.client.scard(PresenceService.ONLINE_KEY);
  }

  // ---- Room membership ----

  async joinRoom(roomId: string, userId: string, isModerator = false): Promise<void> {
    const key = isModerator ? this.roomModeratorsKey(roomId) : this.roomMembersKey(roomId);
    await this.client.sadd(key, userId);
    await this.client.expire(key, 86400);
    await this.client.sadd(this.userRoomsKey(userId), roomId);
    await this.client.expire(this.userRoomsKey(userId), 86400);
  }

  async leaveRoom(roomId: string, userId: string, isModerator = false): Promise<void> {
    const key = isModerator ? this.roomModeratorsKey(roomId) : this.roomMembersKey(roomId);
    await this.client.srem(key, userId);
    await this.client.srem(this.userRoomsKey(userId), roomId);
    if (!isModerator) {
      const count = await this.client.scard(this.roomMembersKey(roomId));
      if (count === 0) {
        await this.client.del(this.roomMembersKey(roomId));
      }
    }
  }

  /**
   * Full-disconnect cleanup calls this without knowing whether the user was
   * present as a public member or an incognito moderator for a given room —
   * `srem` on a set the user isn't in is a harmless no-op, so removing from
   * both sets guarantees cleanup either way.
   */
  async leaveRoomEverywhere(roomId: string, userId: string): Promise<void> {
    await Promise.all([
      this.leaveRoom(roomId, userId, false),
      this.leaveRoom(roomId, userId, true),
    ]);
  }

  async roomMembers(roomId: string): Promise<string[]> {
    return this.client.smembers(this.roomMembersKey(roomId));
  }

  /** Incognito moderators currently present — excluded from `roomMembers`/`roomMemberCount`. */
  async roomModerators(roomId: string): Promise<string[]> {
    return this.client.smembers(this.roomModeratorsKey(roomId));
  }

  async roomMemberCount(roomId: string): Promise<number> {
    return this.client.scard(this.roomMembersKey(roomId));
  }

  async isInRoom(roomId: string, userId: string): Promise<boolean> {
    const [inPublic, inModerators] = await Promise.all([
      this.client.sismember(this.roomMembersKey(roomId), userId),
      this.client.sismember(this.roomModeratorsKey(roomId), userId),
    ]);
    return inPublic === 1 || inModerators === 1;
  }

  /** Rooms a user is currently a member of (used to clean up on disconnect). */
  async userRooms(userId: string): Promise<string[]> {
    return this.client.smembers(this.userRoomsKey(userId));
  }

  // ---- Live Stream Ephemeral Presence (Redis-only, Moderator Anonymous) ----

  private liveStreamViewersKey(streamId: string): string {
    return `presence:livestream:{${streamId}}:viewers`;
  }

  private liveStreamModeratorsKey(streamId: string): string {
    return `presence:livestream:{${streamId}}:moderators`;
  }

  async joinLiveStream(streamId: string, userId: string, isModerator: boolean): Promise<void> {
    if (isModerator) {
      // Ephemeral invisible presence for moderators
      await this.client.sadd(this.liveStreamModeratorsKey(streamId), userId);
      await this.client.expire(this.liveStreamModeratorsKey(streamId), 86400);
    } else {
      // Public viewer presence
      await this.client.sadd(this.liveStreamViewersKey(streamId), userId);
      await this.client.expire(this.liveStreamViewersKey(streamId), 86400);
    }
  }

  async leaveLiveStream(streamId: string, userId: string, isModerator: boolean): Promise<void> {
    if (isModerator) {
      await this.client.srem(this.liveStreamModeratorsKey(streamId), userId);
    } else {
      await this.client.srem(this.liveStreamViewersKey(streamId), userId);
    }
  }

  /** Public viewer count — EXCLUDES moderators. */
  async liveStreamViewerCount(streamId: string): Promise<number> {
    return this.client.scard(this.liveStreamViewersKey(streamId));
  }

  /** Public viewer list — EXCLUDES moderators. */
  async liveStreamViewers(streamId: string): Promise<string[]> {
    return this.client.smembers(this.liveStreamViewersKey(streamId));
  }
}
