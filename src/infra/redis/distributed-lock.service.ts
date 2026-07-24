import { Inject, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { REDIS_CLIENT, RedisClient } from './redis.constants';

export interface LockToken {
  resource: string;
  value: string;
  expiresAt: number;
}

export interface AcquireLockOptions {
  ttlMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

const RELEASE_LUA_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async acquireLock(resource: string, options: AcquireLockOptions = {}): Promise<LockToken | null> {
    const ttlMs = options.ttlMs ?? 5000;
    const maxRetries = options.maxRetries ?? 3;
    const retryDelayMs = options.retryDelayMs ?? 100;

    const lockKey = `lock:${resource}`;
    const lockValue = crypto.randomUUID();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const acquired = await this.redis.set(lockKey, lockValue, 'PX', ttlMs, 'NX');
      if (acquired === 'OK') {
        return {
          resource,
          value: lockValue,
          expiresAt: Date.now() + ttlMs,
        };
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
      }
    }

    this.logger.warn(`Failed to acquire distributed lock for resource [${resource}]`);
    return null;
  }

  async releaseLock(lockToken: LockToken): Promise<boolean> {
    const lockKey = `lock:${lockToken.resource}`;
    try {
      const result = await this.redis.eval(RELEASE_LUA_SCRIPT, 1, lockKey, lockToken.value);
      return result === 1;
    } catch (error) {
      this.logger.error(`Error releasing distributed lock for [${lockToken.resource}]`, error);
      return false;
    }
  }

  async runWithLock<T>(
    resource: string,
    fn: () => Promise<T>,
    options: AcquireLockOptions = {},
  ): Promise<T> {
    const lock = await this.acquireLock(resource, options);
    if (!lock) {
      throw new Error(`Could not acquire distributed lock for resource [${resource}]`);
    }

    try {
      return await fn();
    } finally {
      await this.releaseLock(lock);
    }
  }
}
