import { Module } from '@nestjs/common';
import { AgoraModule } from './agora/agora.module';
import { ZegoModule } from './zego/zego.module';
import { AuthInfraModule } from './auth/auth-infra.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './observability/metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
import { SocketModule } from './socket/socket.module';
import { StorageModule } from './storage/storage.module';

/**
 * Aggregates all cross-cutting infrastructure. Most are @Global(), so importing
 * this once in AppModule makes Prisma/Redis/Queue/Storage/Agora/Auth/Sockets/
 * Metrics available platform-wide.
 */
@Module({
  imports: [
    // Metrics first so MonitoringMetrics is available to the instrumented services.
    MetricsModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    StorageModule,
    AgoraModule,
    ZegoModule,
    AuthInfraModule,
    SocketModule,
    HealthModule,
  ],
})
export class InfraModule {}
