import { Global, Logger, Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cluster, Redis } from 'ioredis';
import { MonitoringMetrics } from '../observability/monitoring.metrics';
import { CacheService } from './cache.service';
import { LockService } from './lock.service';
import { PresenceService } from './presence.service';
import { REDIS_CLIENT, RedisClient } from './redis.constants';
import { instrumentRedisClient } from './redis.instrument';
import { RedisService } from './redis.service';

/**
 * One shared Redis connection for the whole platform, provided under
 * REDIS_CLIENT. Standalone today; set REDIS_CLUSTER_NODES to run in Cluster
 * mode without touching any consumer — the client type (RedisClient) and the
 * command surface are identical either way.
 */
const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService, MonitoringMetrics],
  useFactory: (config: ConfigService, metrics: MonitoringMetrics): RedisClient => {
    const logger = new Logger('RedisClient');
    const { url, clusterNodes } = config.get('redis', { infer: true })!;
    const cluster = clusterNodes.length > 0;

    const client: RedisClient = cluster
      ? new Cluster(clusterNodes, {
          enableReadyCheck: true,
          // Per-node options; null retries keep BullMQ-style blocking clients happy.
          redisOptions: { maxRetriesPerRequest: null },
        })
      : new Redis(url, {
          maxRetriesPerRequest: null, // required for BullMQ-compatible blocking clients
          enableReadyCheck: true,
          lazyConnect: false,
        });

    const mode = cluster ? 'cluster' : 'standalone';
    client.on('connect', () => logger.log(`Redis connecting (${mode})...`));
    client.on('ready', () => logger.log('Redis ready'));
    client.on('error', (err) => logger.error(`Redis error: ${err.message}`));

    // Command timing → redis metrics + slow-op warnings.
    const slowMs = Number(config.get('monitoring', { infer: true })!.slowRedisMs);
    return instrumentRedisClient(client, metrics, new Logger('Redis'), slowMs);
  },
};

@Global()
@Module({
  providers: [redisClientProvider, RedisService, CacheService, PresenceService, LockService],
  exports: [REDIS_CLIENT, RedisService, CacheService, PresenceService, LockService],
})
export class RedisModule {}
