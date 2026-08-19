// Distributed-tracing bootstrap — MUST be first so the OpenTelemetry SDK can
// instrument libraries before they are imported below (no-op unless OTEL_ENABLED).
import './infra/observability/tracing';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { SocketAdapter } from './infra/socket/socket.adapter';

async function bootstrap(): Promise<void> {
  (BigInt.prototype as any).toJSON = function () {
    return Number(this);
  };

  // `rawBody` keeps the untouched request bytes alongside the parsed body.
  // Gateway webhooks (Razorpay) sign the exact bytes they sent, so verifying
  // against a re-serialised object would fail on any key reordering or
  // whitespace difference.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });

  // Structured logging (pino) as the app logger.
  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);
  const appCfg = config.get('app', { infer: true })!;

  // Global API prefix. Ops endpoints stay at root for probes/scrapers.
  app.setGlobalPrefix(appCfg.apiPrefix, {
    exclude: ['health', 'health/live', 'health/ready', 'health/startup', 'metrics'],
  });

  // Validation: strip unknown props, transform payloads to DTO instances.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableCors({ origin: appCfg.corsOrigins, credentials: true });

  // Global Helmet middleware registration for production hardening
  // Disable CSP specifically to allow Swagger UI scripts and assets to load without blockers
  app.use(helmet({ contentSecurityPolicy: false }));

  // Security: Check BullMQ dashboard password credentials
  const nodeEnv = config.get<string>('NODE_ENV', 'development');
  const queueCfg = config.get<any>('queue');
  if (
    nodeEnv === 'production' &&
    (!queueCfg || queueCfg.dashboardPassword === 'soulzaa' || !queueCfg.dashboardPassword)
  ) {
    throw new Error(
      'CRITICAL: BullMQ Dashboard using default or missing password in production environment. Configure QUEUE_DASHBOARD_PASSWORD.',
    );
  }

  // Signal handling is done manually below (`gracefulShutdown`), which calls
  // `app.close()` itself and then guarantees process exit. `enableShutdownHooks()`
  // would register Nest's own SIGINT/SIGTERM listeners alongside that one —
  // both firing on a single Ctrl+C ran the entire `OnModuleDestroy` /
  // `OnApplicationShutdown` lifecycle twice, and the second pass tried to
  // `redis.quit()` a connection `RedisService.onModuleDestroy` had already
  // closed in the first pass, throwing "Connection is closed" during shutdown.

  // Socket.IO with Redis adapter for horizontal scaling.
  const socketAdapter = new SocketAdapter(app);
  await socketAdapter.connectToRedis();
  app.useWebSocketAdapter(socketAdapter);

  // Swagger / OpenAPI docs at /api-docs.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Soulzaa API')
    .setDescription('Soulzaa social entertainment platform — backend API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(appCfg.port, '0.0.0.0');
  const logger = app.get(PinoLogger);
  logger.log(`🚀 Soulzaa backend listening on port ${appCfg.port} (/${appCfg.apiPrefix})`);

  const gracefulShutdown = async () => {
    try {
      await app.close();
    } catch {
      // ignore shutdown errors
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', gracefulShutdown);
  process.once('SIGTERM', gracefulShutdown);
}

void bootstrap();
// Trigger restart to reload .env configuration changes (ZEGOCLOUD 1797841998 active)
