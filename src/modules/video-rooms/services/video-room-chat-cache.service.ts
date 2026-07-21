import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import {
  videoRoomChatPinsKey,
  videoRoomChatRecentKey,
  videoRoomChatTypingKey,
} from '../constants/video-room-chat.constants';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import type { ChatMessagePayload } from '../events/video-room-chat.events';

/**
 * The Redis read model for VR-9 chat: a per-room ring buffer of recent messages,
 * the active pin set, and the typing roster. This is a CACHE, never a source of
 * truth — Postgres holds the durable record, so losing Redis costs a rebuild and
 * never data. Every key is single-key and `{roomId}`-hash-tagged, so every
 * operation is Redis-Cluster-safe.
 *
 * The ring buffer is what keeps 10k viewers joining a live room off Postgres:
 * they all request the same page 1, and it is served from memory.
 */
@Injectable()
export class VideoRoomChatCacheService {
  private readonly logger = new Logger(VideoRoomChatCacheService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly config: ConfigService,
  ) {}

  private cfg() {
    return loadVideoRoomChatConfig(this.config);
  }

  // ---- Recent-message ring buffer ----

  async pushRecent(roomId: string, message: ChatMessagePayload): Promise<void> {
    const { recentBufferSize, recentBufferTtlSeconds } = this.cfg();
    const key = videoRoomChatRecentKey(roomId);
    await this.redis.lpush(key, JSON.stringify(message));
    await this.redis.ltrim(key, 0, recentBufferSize - 1);
    await this.redis.expire(key, recentBufferTtlSeconds);
  }

  /**
   * Newest-first recent messages. A corrupt entry is skipped rather than thrown:
   * this is a cache, and poisoning it must not break the read path.
   */
  async readRecent(roomId: string, limit: number): Promise<ChatMessagePayload[]> {
    const raw = await this.redis.lrange(videoRoomChatRecentKey(roomId), 0, limit - 1);
    const out: ChatMessagePayload[] = [];
    for (const entry of raw) {
      try {
        out.push(JSON.parse(entry) as ChatMessagePayload);
      } catch {
        this.logger.warn(`Discarding corrupt chat cache entry in room ${roomId}`);
      }
    }
    return out;
  }

  async invalidateRecent(roomId: string): Promise<void> {
    await this.redis.del(videoRoomChatRecentKey(roomId));
  }

  // ---- Pin set ----

  async setPins(roomId: string, messageIds: string[]): Promise<void> {
    const key = videoRoomChatPinsKey(roomId);
    await this.redis.del(key);
    if (messageIds.length > 0) await this.redis.sadd(key, ...messageIds);
  }

  /** Active pin ids, or null when the set has never been populated. */
  async readPins(roomId: string): Promise<string[] | null> {
    const members = await this.redis.smembers(videoRoomChatPinsKey(roomId));
    return members.length > 0 ? members : null;
  }

  // ---- Typing roster ----

  /**
   * Score is the ABSOLUTE expiry instant, not a TTL, so a stale entry is
   * self-evident to any reader on any instance without a sweeper.
   */
  async markTyping(roomId: string, userId: string, ttlSeconds: number): Promise<void> {
    await this.redis.zadd(videoRoomChatTypingKey(roomId), Date.now() + ttlSeconds * 1000, userId);
  }

  async clearTyping(roomId: string, userId: string): Promise<void> {
    await this.redis.zrem(videoRoomChatTypingKey(roomId), userId);
  }

  /** Currently-typing user ids, pruning anyone whose score has passed. */
  async readTyping(roomId: string, nowMs: number): Promise<string[]> {
    const key = videoRoomChatTypingKey(roomId);
    await this.redis.zremrangebyscore(key, '-inf', nowMs);
    return this.redis.zrangebyscore(key, nowMs, '+inf');
  }
}
