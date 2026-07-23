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

  async joinRoom(roomId: string, userId: string): Promise<void> {
    await this.client.sadd(this.roomMembersKey(roomId), userId);
    await this.client.expire(this.roomMembersKey(roomId), 86400);
    await this.client.sadd(this.userRoomsKey(userId), roomId);
    await this.client.expire(this.userRoomsKey(userId), 86400);
  }

  async leaveRoom(roomId: string, userId: string): Promise<void> {
    await this.client.srem(this.roomMembersKey(roomId), userId);
    await this.client.srem(this.userRoomsKey(userId), roomId);
    const count = await this.client.scard(this.roomMembersKey(roomId));
    if (count === 0) {
      await this.client.del(this.roomMembersKey(roomId));
    }
  }

  async roomMembers(roomId: string): Promise<string[]> {
    return this.client.smembers(this.roomMembersKey(roomId));
  }

  async roomMemberCount(roomId: string): Promise<number> {
    return this.client.scard(this.roomMembersKey(roomId));
  }

  async isInRoom(roomId: string, userId: string): Promise<boolean> {
    return (await this.client.sismember(this.roomMembersKey(roomId), userId)) === 1;
  }

  /** Rooms a user is currently a member of (used to clean up on disconnect). */
  async userRooms(userId: string): Promise<string[]> {
    return this.client.smembers(this.userRoomsKey(userId));
  }
}
