import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { loadVideoRoomAnalyticsConfig } from '../config/video-room-analytics.config';
import { VIDEO_ROOM_ANALYTICS_REDIS_KEYS } from '../constants/video-room-analytics.constants';
import { AnalyticsCacheException } from '../exceptions/video-room-analytics.exception';

export interface LiveActiveMetrics {
  activeRooms: number;
  activeHosts: number;
  activeParticipants: number;
  activeViewers: number;
  concurrentPkBattles: number;
  concurrentGifts: number;
  concurrentTreasureEvents: number;
}

@Injectable()
export class VideoRoomAnalyticsCacheService {
  private readonly logger = new Logger(VideoRoomAnalyticsCacheService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly config: ConfigService,
  ) {}

  private get cfg() {
    return loadVideoRoomAnalyticsConfig(this.config);
  }

  // ---- Active Counters ----

  async incrementActiveRooms(roomId: string): Promise<void> {
    try {
      await this.redis.sadd(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_ROOMS, roomId);
    } catch (err: any) {
      this.logger.error(`Failed incrementActiveRooms: ${err.message}`);
    }
  }

  async decrementActiveRooms(roomId: string): Promise<void> {
    try {
      await this.redis.srem(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_ROOMS, roomId);
    } catch (err: any) {
      this.logger.error(`Failed decrementActiveRooms: ${err.message}`);
    }
  }

  async incrementActiveHosts(hostId: string): Promise<void> {
    try {
      await this.redis.sadd(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_HOSTS, hostId);
    } catch (err: any) {
      this.logger.error(`Failed incrementActiveHosts: ${err.message}`);
    }
  }

  async decrementActiveHosts(hostId: string): Promise<void> {
    try {
      await this.redis.srem(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_HOSTS, hostId);
    } catch (err: any) {
      this.logger.error(`Failed decrementActiveHosts: ${err.message}`);
    }
  }

  async trackActiveParticipant(userId: string): Promise<void> {
    try {
      await this.redis.sadd(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_PARTICIPANTS, userId);
    } catch (err: any) {
      this.logger.error(`Failed trackActiveParticipant: ${err.message}`);
    }
  }

  async untrackActiveParticipant(userId: string): Promise<void> {
    try {
      await this.redis.srem(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_PARTICIPANTS, userId);
    } catch (err: any) {
      this.logger.error(`Failed untrackActiveParticipant: ${err.message}`);
    }
  }

  async trackActiveViewer(userId: string): Promise<void> {
    try {
      await this.redis.sadd(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_VIEWERS, userId);
    } catch (err: any) {
      this.logger.error(`Failed trackActiveViewer: ${err.message}`);
    }
  }

  async untrackActiveViewer(userId: string): Promise<void> {
    try {
      await this.redis.srem(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_VIEWERS, userId);
    } catch (err: any) {
      this.logger.error(`Failed untrackActiveViewer: ${err.message}`);
    }
  }

  async setConcurrentPkBattles(count: number): Promise<void> {
    try {
      await this.redis.set(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.CONCURRENT_PK, String(count));
    } catch (err: any) {
      this.logger.error(`Failed setConcurrentPkBattles: ${err.message}`);
    }
  }

  async setConcurrentGifts(count: number): Promise<void> {
    try {
      await this.redis.set(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.CONCURRENT_GIFTS, String(count));
    } catch (err: any) {
      this.logger.error(`Failed setConcurrentGifts: ${err.message}`);
    }
  }

  async setConcurrentTreasureEvents(count: number): Promise<void> {
    try {
      await this.redis.set(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.CONCURRENT_TREASURE, String(count));
    } catch (err: any) {
      this.logger.error(`Failed setConcurrentTreasureEvents: ${err.message}`);
    }
  }

  async getLiveActiveMetrics(): Promise<LiveActiveMetrics> {
    try {
      const [rooms, hosts, participants, viewers, pk, gifts, treasure] = await Promise.all([
        this.redis.scard(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_ROOMS),
        this.redis.scard(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_HOSTS),
        this.redis.scard(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_PARTICIPANTS),
        this.redis.scard(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.ACTIVE_VIEWERS),
        this.redis.get(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.CONCURRENT_PK),
        this.redis.get(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.CONCURRENT_GIFTS),
        this.redis.get(VIDEO_ROOM_ANALYTICS_REDIS_KEYS.CONCURRENT_TREASURE),
      ]);

      return {
        activeRooms: rooms ?? 0,
        activeHosts: hosts ?? 0,
        activeParticipants: participants ?? 0,
        activeViewers: viewers ?? 0,
        concurrentPkBattles: pk ? parseInt(pk, 10) : 0,
        concurrentGifts: gifts ? parseInt(gifts, 10) : 0,
        concurrentTreasureEvents: treasure ? parseInt(treasure, 10) : 0,
      };
    } catch (err: any) {
      this.logger.error(`Failed getLiveActiveMetrics: ${err.message}`);
      return {
        activeRooms: 0,
        activeHosts: 0,
        activeParticipants: 0,
        activeViewers: 0,
        concurrentPkBattles: 0,
        concurrentGifts: 0,
        concurrentTreasureEvents: 0,
      };
    }
  }

  // ---- Analytics Caching ----

  async getCachedAnalytics<T = unknown>(
    targetId: string,
    period: string,
    dateKey?: string,
  ): Promise<T | null> {
    try {
      const key = VIDEO_ROOM_ANALYTICS_REDIS_KEYS.CACHE_ROOM(targetId, period, dateKey);
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err: any) {
      this.logger.warn(`Cache read failed for target ${targetId}: ${err.message}`);
      return null;
    }
  }

  async setCachedAnalytics(
    targetId: string,
    period: string,
    data: unknown,
    ttlSeconds?: number,
    dateKey?: string,
  ): Promise<void> {
    try {
      const key = VIDEO_ROOM_ANALYTICS_REDIS_KEYS.CACHE_ROOM(targetId, period, dateKey);
      const effectiveTtl = ttlSeconds ?? this.cfg.aggregatedCacheTtlSeconds;
      await this.redis.setex(key, effectiveTtl, JSON.stringify(data));
    } catch (err: any) {
      throw new AnalyticsCacheException(`Failed to set analytics cache: ${err.message}`);
    }
  }

  async invalidateAnalyticsCache(
    targetId: string,
    period: string,
    dateKey?: string,
  ): Promise<void> {
    try {
      const key = VIDEO_ROOM_ANALYTICS_REDIS_KEYS.CACHE_ROOM(targetId, period, dateKey);
      await this.redis.del(key);
    } catch (err: any) {
      this.logger.warn(`Failed cache invalidation for target ${targetId}: ${err.message}`);
    }
  }
}
