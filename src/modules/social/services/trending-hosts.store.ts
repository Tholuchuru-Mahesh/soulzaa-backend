import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { TRENDING_HOSTS_KEY } from '../constants/social.constants';

/** Seconds the trending set lives without new activity (rolling ~7-day window). */
const TRENDING_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Redis sorted-set of trending hosts, incremented when a user opens a room. The
 * whole key's TTL slides forward on each bump, giving an approximate rolling
 * window without per-member decay bookkeeping. Backs the "trending" recommendation.
 */
@Injectable()
export class TrendingHostsStore {
  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisClient) {}

  async bump(userId: string, by = 1): Promise<void> {
    await this.client.zincrby(TRENDING_HOSTS_KEY, by, userId);
    await this.client.expire(TRENDING_HOSTS_KEY, TRENDING_TTL_SECONDS);
  }

  async top(limit: number): Promise<{ userId: string; score: number }[]> {
    if (limit <= 0) return [];
    const raw = await this.client.zrevrange(TRENDING_HOSTS_KEY, 0, limit - 1, 'WITHSCORES');
    const out: { userId: string; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      out.push({ userId: raw[i], score: Number(raw[i + 1]) });
    }
    return out;
  }
}
