import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { EventLoopHealthIndicator } from './event-loop.health';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './prisma.health';
import { QueueHealthIndicator } from './queue.health';
import { RedisHealthIndicator } from './redis.health';
import { SocketHealthIndicator } from './socket.health';
import { StorageHealthIndicator } from './storage.health';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    PrismaHealthIndicator,
    RedisHealthIndicator,
    QueueHealthIndicator,
    StorageHealthIndicator,
    SocketHealthIndicator,
    EventLoopHealthIndicator,
  ],
})
export class HealthModule {}
