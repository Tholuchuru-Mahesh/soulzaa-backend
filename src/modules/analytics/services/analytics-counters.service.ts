import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, type RedisClient } from 'src/infra/redis/redis.constants';
import {
  ANALYTICS_COUNTER_TTL_SECONDS,
  type CreatorCounterField,
  type RoomCounterField,
  creatorCounterKey,
  creatorsActiveKey,
  roomCounterKey,
  roomPeakKey,
  roomVisitorsKey,
  roomsActiveKey,
} from '../constants/analytics.constants';

export interface RoomCounters {
  joins: number;
  messages: number;
  giftCount: number;
  giftCoins: number;
  speakingSeconds: number;
  uniqueVisitors: number;
  peakParticipants: number;
}

export interface CreatorCounters {
  giftsReceivedCount: number;
  giftCoinsReceived: number;
  creatorEarnings: number;
  roomsHosted: number;
  speakingSeconds: number;
}

/**
 * Real-time analytics counters in Redis, scoped per (entity, day). Source-event
 * handlers increment these for instant "today" reads; the nightly rollup job
 * materializes them into durable daily-stat tables. Every key self-expires after
 * a few days so nothing lingers once rolled up.
 */
@Injectable()
export class AnalyticsCountersService {
  private readonly ttl = ANALYTICS_COUNTER_TTL_SECONDS;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async incrRoom(roomId: string, dateKey: string, field: RoomCounterField, by = 1): Promise<void> {
    if (by === 0) return;
    await this.redis
      .pipeline()
      .hincrby(roomCounterKey(roomId, dateKey), field, by)
      .expire(roomCounterKey(roomId, dateKey), this.ttl)
      .sadd(roomsActiveKey(dateKey), roomId)
      .expire(roomsActiveKey(dateKey), this.ttl)
      .exec();
  }

  async addRoomVisitor(roomId: string, dateKey: string, userId: string): Promise<void> {
    await this.redis
      .pipeline()
      .sadd(roomVisitorsKey(roomId, dateKey), userId)
      .expire(roomVisitorsKey(roomId, dateKey), this.ttl)
      .sadd(roomsActiveKey(dateKey), roomId)
      .expire(roomsActiveKey(dateKey), this.ttl)
      .exec();
  }

  async bumpRoomPeak(roomId: string, dateKey: string, participantCount: number): Promise<void> {
    if (participantCount <= 0) return;
    // ZADD GT only raises the stored peak, never lowers it — atomic max.
    await this.redis
      .pipeline()
      .zadd(roomPeakKey(roomId, dateKey), 'GT', participantCount, 'peak')
      .expire(roomPeakKey(roomId, dateKey), this.ttl)
      .exec();
  }

  async incrCreator(
    userId: string,
    dateKey: string,
    field: CreatorCounterField,
    by = 1,
  ): Promise<void> {
    if (by === 0) return;
    await this.redis
      .pipeline()
      .hincrby(creatorCounterKey(userId, dateKey), field, by)
      .expire(creatorCounterKey(userId, dateKey), this.ttl)
      .sadd(creatorsActiveKey(dateKey), userId)
      .expire(creatorsActiveKey(dateKey), this.ttl)
      .exec();
  }

  async readRoom(roomId: string, dateKey: string): Promise<RoomCounters> {
    const [hash, uniqueVisitors, peak] = await Promise.all([
      this.redis.hgetall(roomCounterKey(roomId, dateKey)),
      this.redis.scard(roomVisitorsKey(roomId, dateKey)),
      this.redis.zscore(roomPeakKey(roomId, dateKey), 'peak'),
    ]);
    return {
      joins: num(hash.joins),
      messages: num(hash.messages),
      giftCount: num(hash.giftCount),
      giftCoins: num(hash.giftCoins),
      speakingSeconds: num(hash.speakingSeconds),
      uniqueVisitors: uniqueVisitors ?? 0,
      peakParticipants: num(peak),
    };
  }

  async readCreator(userId: string, dateKey: string): Promise<CreatorCounters> {
    const hash = await this.redis.hgetall(creatorCounterKey(userId, dateKey));
    return {
      giftsReceivedCount: num(hash.giftsReceivedCount),
      giftCoinsReceived: num(hash.giftCoinsReceived),
      creatorEarnings: num(hash.creatorEarnings),
      roomsHosted: num(hash.roomsHosted),
      speakingSeconds: num(hash.speakingSeconds),
    };
  }

  listActiveRooms(dateKey: string): Promise<string[]> {
    return this.redis.smembers(roomsActiveKey(dateKey));
  }

  listActiveCreators(dateKey: string): Promise<string[]> {
    return this.redis.smembers(creatorsActiveKey(dateKey));
  }
}

function num(v: string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
