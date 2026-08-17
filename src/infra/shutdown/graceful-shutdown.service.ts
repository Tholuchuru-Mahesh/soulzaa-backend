import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';

/**
 * Shutdown-sequence logging only. Does **not** close Prisma or Redis itself —
 * `PrismaService`/`RedisService` already own that via their own
 * `OnModuleDestroy` hooks, which Nest runs before `OnApplicationShutdown`
 * hooks like this one. Closing them again here was a redundant second
 * `redis.quit()` on an already-closed connection, which ioredis rejects with
 * "Connection is closed" and surfaces as a shutdown error.
 */
@Injectable()
export class GracefulShutdownService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(GracefulShutdownService.name);

  beforeApplicationShutdown(signal?: string) {
    this.logger.log(`Initiating graceful shutdown sequence (Signal: ${signal || 'SIGTERM'})`);
  }

  onApplicationShutdown(signal?: string) {
    this.logger.log(`Graceful shutdown completed for signal: ${signal || 'SIGTERM'}`);
  }
}
