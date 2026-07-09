import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule } from '@nestjs/bullmq';
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { EmailsProcessor } from './processors/emails.processor';
import { GiftProcessingProcessor } from './processors/gift-processing.processor';
import { MediaProcessingProcessor } from './processors/media-processing.processor';
import { NotificationsProcessor } from './processors/notifications.processor';
import { WalletProcessingProcessor } from './processors/wallet-processing.processor';
import { ALL_QUEUE_NAMES } from './queue.constants';
import { QueueMetrics } from './queue.metrics';
import { QueueMonitorService } from './queue.monitor';
import { QueueService } from './queue.service';
import { QueueSupport } from './workers/queue-support.service';

const PROCESSORS = [
  NotificationsProcessor,
  EmailsProcessor,
  GiftProcessingProcessor,
  // RANKING_PROCESSING and ANALYTICS_PROCESSING are consumed by domain-owned
  // workers in the rankings/analytics modules (RankingsProcessor/AnalyticsProcessor)
  // — kept boundary-clean (no infra → module dep).
  MediaProcessingProcessor,
  WalletProcessingProcessor,
];

/** HTTP Basic auth guarding the Bull Board Express mount (bypasses Nest guards). */
function basicAuth(user: string, password: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
      if (u === user && p === password) {
        next();
        return;
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="Soulzaa Queues"').status(401).send('Auth required');
  };
}

/**
 * Global BullMQ setup: shared Redis connection + default job options (retries,
 * exponential backoff, removal policies), all queues (job queues + dead-letter),
 * the producer/monitor/worker-support providers, the seven processors, and the
 * Bull Board dashboard.
 *
 * SECURITY: the dashboard route is served through a Nest controller, so the
 * global JwtAuthGuard applies; still restrict it to admin roles / internal
 * network before production.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.get<string>('redis.url', { infer: true })! },
        prefix: config.get<string>('queue.prefix', { infer: true }),
        defaultJobOptions: {
          attempts: config.get<number>('queue.defaultAttempts', { infer: true }),
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 24 * 3600 },
        },
      }),
    }),
    ...ALL_QUEUE_NAMES.map((name) => BullModule.registerQueue({ name })),
    BullBoardModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const cfg = config.get('queue', { infer: true })!;
        if (cfg.dashboardPassword === 'soulzaa') {
          new Logger('QueueModule').warn(
            'Bull Board is using the default dashboard password — set QUEUE_DASHBOARD_PASSWORD.',
          );
        }
        return {
          route: cfg.dashboardRoute,
          adapter: ExpressAdapter,
          middleware: basicAuth(cfg.dashboardUser, cfg.dashboardPassword),
        };
      },
    }),
    ...ALL_QUEUE_NAMES.map((name) => BullBoardModule.forFeature({ name, adapter: BullMQAdapter })),
  ],
  providers: [QueueService, QueueMetrics, QueueSupport, QueueMonitorService, ...PROCESSORS],
  // QueueSupport is exported so domain-owned processors (e.g. the OTP module's
  // delivery workers) can extend BaseQueueWorker and reuse metrics + dead-letter.
  exports: [BullModule, QueueService, QueueSupport],
})
export class QueueModule {}
