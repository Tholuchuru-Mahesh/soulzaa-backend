import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { RedisService } from '../redis/redis.service';

/**
 * Readiness: is the Socket.IO layer able to fan out across instances? The
 * Socket.IO adapter is Redis pub/sub-backed, so its readiness tracks Redis
 * reachability (the adapter uses duplicated connections of the shared client).
 */
@Injectable()
export class SocketHealthIndicator {
  constructor(
    private readonly redis: RedisService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const ok = await this.redis.ping();
      return ok ? indicator.up() : indicator.down({ message: 'socket adapter (redis) not ready' });
    } catch (err) {
      return indicator.down({ message: (err as Error).message });
    }
  }
}
