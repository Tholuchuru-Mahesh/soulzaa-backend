import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsService } from './metrics.service';

/**
 * Per-subsystem Prometheus metrics (DB, Redis, Storage, Socket) registered on
 * the shared registry so they are exposed at /metrics. Infra services inject
 * this and call the record* helpers; definitions stay centralised here (mirrors
 * the queue QueueMetrics pattern).
 */
@Injectable()
export class MonitoringMetrics {
  // ---- Database (Prisma) ----
  private readonly dbQueryDuration: Histogram<'op'>;
  private readonly dbQueries: Counter<'op'>;
  // ---- Redis ----
  private readonly redisDuration: Histogram<'command'>;
  private readonly redisCommands: Counter<'command'>;
  // ---- Storage (S3) ----
  private readonly storageOps: Counter<'op' | 'result'>;
  private readonly storageBytes: Counter<'direction'>;
  // ---- Socket ----
  private readonly socketClients: Gauge;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];
    this.dbQueryDuration = new Histogram({
      name: 'db_query_duration_seconds',
      help: 'Prisma query duration in seconds',
      labelNames: ['op'] as const,
      buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 2],
      registers,
    });
    this.dbQueries = new Counter({
      name: 'db_queries_total',
      help: 'Total Prisma queries',
      labelNames: ['op'] as const,
      registers,
    });
    this.redisDuration = new Histogram({
      name: 'redis_command_duration_seconds',
      help: 'Redis command duration in seconds',
      labelNames: ['command'] as const,
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.3, 1],
      registers,
    });
    this.redisCommands = new Counter({
      name: 'redis_commands_total',
      help: 'Total Redis commands',
      labelNames: ['command'] as const,
      registers,
    });
    this.storageOps = new Counter({
      name: 'storage_operations_total',
      help: 'Total S3 storage operations',
      labelNames: ['op', 'result'] as const,
      registers,
    });
    this.storageBytes = new Counter({
      name: 'storage_bytes_total',
      help: 'Total bytes transferred to/from storage',
      labelNames: ['direction'] as const,
      registers,
    });
    this.socketClients = new Gauge({
      name: 'socket_connected_clients',
      help: 'Sockets currently connected on this instance',
      registers,
    });
  }

  observeDbQuery(op: string, seconds: number): void {
    this.dbQueryDuration.observe({ op }, seconds);
    this.dbQueries.inc({ op });
  }

  observeRedisCommand(command: string, seconds: number): void {
    this.redisDuration.observe({ command }, seconds);
    this.redisCommands.inc({ command });
  }

  recordStorageOp(op: string, result: 'success' | 'error'): void {
    this.storageOps.inc({ op, result });
  }

  recordStorageBytes(direction: 'up' | 'down', bytes: number): void {
    if (bytes > 0) this.storageBytes.inc({ direction }, bytes);
  }

  setConnectedClients(count: number): void {
    this.socketClients.set(count);
  }
}
