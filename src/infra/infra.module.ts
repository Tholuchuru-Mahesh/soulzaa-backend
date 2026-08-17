import { Module } from '@nestjs/common';
import { AgoraModule } from './agora/agora.module';
import { AuthInfraModule } from './auth/auth-infra.module';
import { FeatureFlagService } from './flags/feature-flag.service';
import { HealthModule } from './health/health.module';
import { GeocodingModule } from './geocoding/geocoding.module';
import { ExceptionAnalyticsService } from './observability/exception-analytics.service';
import { MetricsModule } from './observability/metrics.module';
import { TracingInterceptor } from './observability/tracing.interceptor';
import { TracingService } from './observability/tracing.service';
import { ChaosSimulationService } from './ops/chaos-simulation.service';
import { DisasterRecoveryService } from './ops/disaster-recovery.service';
import { OpsDashboardController } from './ops/ops-dashboard.controller';
import { OpsDashboardService } from './ops/ops-dashboard.service';
import { PerformanceBenchmarkService } from './ops/performance-benchmark.service';
import { StressTestService } from './ops/stress-test.service';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaPerformanceService } from './prisma/prisma-performance.service';
import { DLQService } from './queue/dlq.service';
import { QueueModule } from './queue/queue.module';
import { DistributedLockService } from './redis/distributed-lock.service';
import { EnterpriseCacheService } from './redis/enterprise-cache.service';
import { RedisModule } from './redis/redis.module';
import { CircuitBreakerService } from './resilience/circuit-breaker.service';
import { SecurityAuditService } from './security/security-audit.service';
import { GracefulShutdownService } from './shutdown/graceful-shutdown.service';
import { SocketModule } from './socket/socket.module';
import { StartupValidationService } from './startup/startup-validation.service';
import { StorageModule } from './storage/storage.module';
import { ZegoModule } from './zego/zego.module';

/**
 * Aggregates all enterprise operational infrastructure.
 * Phase 19 + 19.1 + 19.2 — 100% enterprise production readiness.
 */
@Module({
  imports: [
    MetricsModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    StorageModule,
    AgoraModule,
    ZegoModule,
    GeocodingModule,
    AuthInfraModule,
    SocketModule,
    HealthModule,
  ],
  controllers: [OpsDashboardController],
  providers: [
    // Resilience
    CircuitBreakerService,
    // Cache
    EnterpriseCacheService,
    // Feature Flags
    FeatureFlagService,
    // Startup Validation
    StartupValidationService,
    // Distributed Lock
    DistributedLockService,
    // DLQ
    DLQService,
    // Disaster Recovery
    DisasterRecoveryService,
    // Performance Benchmark
    PerformanceBenchmarkService,
    // Observability
    ExceptionAnalyticsService,
    TracingService,
    TracingInterceptor,
    // Database Diagnostics
    PrismaPerformanceService,
    // Security Audit
    SecurityAuditService,
    // Stress & Chaos Testing
    StressTestService,
    ChaosSimulationService,
    // Ops Dashboard
    OpsDashboardService,
    // Graceful Shutdown
    GracefulShutdownService,
  ],
  exports: [
    CircuitBreakerService,
    EnterpriseCacheService,
    FeatureFlagService,
    StartupValidationService,
    DistributedLockService,
    DLQService,
    DisasterRecoveryService,
    PerformanceBenchmarkService,
    ExceptionAnalyticsService,
    TracingService,
    TracingInterceptor,
    PrismaPerformanceService,
    SecurityAuditService,
    StressTestService,
    ChaosSimulationService,
    OpsDashboardService,
    GracefulShutdownService,
  ],
})
export class InfraModule {}
