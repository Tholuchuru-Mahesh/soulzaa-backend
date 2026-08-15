import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { buildPooledUrl } from 'src/config/configuration';
import { MonitoringMetrics } from '../observability/monitoring.metrics';

/**
 * Single Prisma client for the whole monolith. When a module is extracted
 * into its own service later, it takes its owned models + a scoped copy of
 * this service — the call sites don't change.
 *
 * The client-side connection pool is tuned from the `database` config
 * namespace: `connection_limit`, `pool_timeout` and `connect_timeout` are
 * appended to the runtime `datasourceUrl`. When the URL points at PgBouncer
 * (`pgbouncer=true`), Prisma disables prepared statements automatically.
 * Migrations use the schema's `directUrl` and bypass the pooler.
 *
 * Query events feed DB metrics and slow-query logging (warn/error thresholds
 * from the `monitoring` config). Query params are never logged.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly poolSettings: { connectionLimit?: number; poolTimeout: number };
  private readonly slowWarnMs: number;
  private readonly slowErrorMs: number;

  constructor(
    config: ConfigService,
    private readonly metrics: MonitoringMetrics,
  ) {
    const db = config.get('database', { infer: true })!;
    super({
      datasourceUrl: buildPooledUrl(db.url, {
        connectionLimit: db.connectionLimit,
        poolTimeout: db.poolTimeout,
        connectTimeout: db.connectTimeout,
      }),
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    this.poolSettings = { connectionLimit: db.connectionLimit, poolTimeout: db.poolTimeout };

    const mon = config.get('monitoring', { infer: true })!;
    this.slowWarnMs = Number(mon.slowQueryWarnMs);
    this.slowErrorMs = Number(mon.slowQueryErrorMs);
    this.registerQueryLogging();
  }

  private registerQueryLogging(): void {
    // `$on('query')` typing is lost when extending PrismaClient — cast the event name.
    this.$on('query' as never, (event: Prisma.QueryEvent) => {
      const op = event.query.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? 'UNKNOWN';
      this.metrics.observeDbQuery(op, event.duration / 1000);
      if (event.duration >= this.slowErrorMs) {
        this.logger.error(`slow query (${event.duration}ms): ${event.query}`);
      } else if (event.duration >= this.slowWarnMs) {
        this.logger.warn(`slow query (${event.duration}ms): ${event.query}`);
      }
    });
    this.$on('warn' as never, (event: Prisma.LogEvent) => this.logger.warn(event.message));
    this.$on('error' as never, (event: Prisma.LogEvent) => this.logger.error(event.message));
  }

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry();
    this.logger.log(
      `Prisma connected to PostgreSQL (connection_limit=${
        this.poolSettings.connectionLimit ?? 'default'
      }, pool_timeout=${this.poolSettings.poolTimeout}s)`,
    );
  }

  /**
   * Connects with a bounded retry so a slow-starting dependency (e.g. the
   * Dockerized Postgres coming up alongside the app) doesn't kill the boot
   * with an immediate P1001. Retries up to ~30s, then rethrows so the app
   * still fails loudly if the database is genuinely unreachable.
   */
  private async connectWithRetry(): Promise<void> {
    const maxAttempts = 15;
    const retryDelayMs = 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.$connect();
        return;
      } catch (error) {
        if (attempt >= maxAttempts) throw error;
        this.logger.warn(
          `Prisma connect failed (attempt ${attempt}/${maxAttempts}): ${
            (error as Error).message
          } — retrying in ${retryDelayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
