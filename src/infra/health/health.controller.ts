import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus';
import { Public } from '../../common/decorators/public.decorator';
import { EventLoopHealthIndicator } from './event-loop.health';
import { PrismaHealthIndicator } from './prisma.health';
import { QueueHealthIndicator } from './queue.health';
import { RedisHealthIndicator } from './redis.health';
import { SocketHealthIndicator } from './socket.health';
import { StorageHealthIndicator } from './storage.health';
import { SystemHealthIndicator } from './system.health';
import { ZegoHealthIndicator } from './zego.health';

/** ~1.5GB RSS ceiling for the liveness memory check. */
const MAX_RSS_BYTES = 1_536 * 1024 * 1024;

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly queues: QueueHealthIndicator,
    private readonly storage: StorageHealthIndicator,
    private readonly socket: SocketHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly eventLoop: EventLoopHealthIndicator,
    private readonly zego: ZegoHealthIndicator,
    private readonly system: SystemHealthIndicator,
  ) {}

  /** Liveness — is the process up and responsive? (no external deps) */
  @Get()
  @Public()
  @HealthCheck()
  liveness() {
    return this.health.check([() => this.eventLoop.isHealthy('event_loop')]);
  }

  /** Liveness alias (k8s livenessProbe): process + memory + event-loop health. */
  @Get('live')
  @Public()
  @HealthCheck()
  live() {
    return this.livenessChecks();
  }

  /** Readiness — can we serve traffic? Checks every external dependency. */
  @Get('ready')
  @Public()
  @HealthCheck()
  readiness() {
    return this.readinessChecks();
  }

  /** Deep health check — exhaustive infrastructure and resource diagnostic. */
  @Get('deep')
  @Public()
  @HealthCheck()
  deep() {
    return this.deepChecks();
  }

  /** Startup probe — gate liveness until all dependencies are reachable once. */
  @Get('startup')
  @Public()
  @HealthCheck()
  startup() {
    return this.readinessChecks();
  }

  private livenessChecks() {
    return this.health.check([
      () => this.memory.checkRSS('memory_rss', MAX_RSS_BYTES),
      () => this.eventLoop.isHealthy('event_loop'),
    ]);
  }

  private readinessChecks() {
    return this.health.check([
      () => this.prisma.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
      () => this.queues.isHealthy('queues'),
      () => this.storage.isHealthy('storage'),
      () => this.socket.isHealthy('socket'),
    ]);
  }

  private deepChecks() {
    return this.health.check([
      () => this.prisma.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
      () => this.queues.isHealthy('queues'),
      () => this.storage.isHealthy('storage'),
      () => this.socket.isHealthy('socket'),
      () => this.memory.checkRSS('memory_rss', MAX_RSS_BYTES),
      () => this.eventLoop.isHealthy('event_loop'),
      () => this.zego.isHealthy('zego'),
      () => this.system.isHealthy('system'),
    ]);
  }
}
