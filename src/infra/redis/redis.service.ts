import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cluster } from 'ioredis';
import { REDIS_CLIENT, RedisClient } from './redis.constants';

/**
 * Thin wrapper over the shared connection (standalone or Cluster). Owns the
 * connection lifecycle and hands out the raw `client` plus `duplicate()` for
 * consumers that need their own connection (Socket.IO pub/sub, BullMQ blocking
 * clients). Higher-level helpers live in CacheService, PresenceService and
 * LockService; domain modules that need bespoke data structures (e.g. ZSET
 * rankings) can use `client` directly.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) public readonly client: RedisClient) {}

  /** A fresh connection sharing the same config (pub/sub, blocking ops, adapters). */
  duplicate(): RedisClient {
    // Narrow the union so we hit each concrete `duplicate()` signature.
    return this.client instanceof Cluster ? this.client.duplicate() : this.client.duplicate();
  }

  async ping(): Promise<boolean> {
    const res = await this.client.ping();
    return res === 'PONG';
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis connection closed');
  }
}
