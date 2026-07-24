import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from './redis.constants';

@Injectable()
export class EnterpriseCacheService {
  private readonly logger = new Logger(EnterpriseCacheService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisClient) {}

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const fullKey = `${namespace}:${key}`;
    const raw = await this.client.get(fullKey);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set<T>(namespace: string, key: string, value: T, ttlSeconds: number = 300): Promise<void> {
    const fullKey = `${namespace}:${key}`;
    const payload = JSON.stringify(value);
    await this.client.set(fullKey, payload, 'EX', ttlSeconds);
  }

  async del(namespace: string, key: string): Promise<void> {
    const fullKey = `${namespace}:${key}`;
    await this.client.del(fullKey);
  }

  async invalidateNamespace(namespace: string): Promise<number> {
    const pattern = `${namespace}:*`;
    const keys = await this.client.keys(pattern);
    if (keys.length > 0) {
      return this.client.del(...keys);
    }
    return 0;
  }
}
