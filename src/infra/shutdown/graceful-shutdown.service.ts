import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from '../redis/redis.constants';

@Injectable()
export class GracefulShutdownService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(GracefulShutdownService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  beforeApplicationShutdown(signal?: string) {
    this.logger.log(`Initiating graceful shutdown sequence (Signal: ${signal || 'SIGTERM'})`);
  }

  async onApplicationShutdown(signal?: string) {
    this.logger.log(
      `Draining connections and releasing resources for signal: ${signal || 'SIGTERM'}`,
    );

    try {
      await this.prisma.$disconnect();
      this.logger.log('Prisma PostgreSQL connection closed cleanly.');
    } catch (err) {
      this.logger.error('Error disconnecting Prisma during shutdown', err);
    }

    try {
      await this.redis.quit();
      this.logger.log('Redis client disconnected cleanly.');
    } catch (err) {
      this.logger.error('Error disconnecting Redis during shutdown', err);
    }

    this.logger.log('Graceful shutdown completed successfully.');
  }
}
