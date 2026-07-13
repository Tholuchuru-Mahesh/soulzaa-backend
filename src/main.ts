// Distributed-tracing bootstrap — MUST be first so the OpenTelemetry SDK can
// instrument libraries before they are imported below (no-op unless OTEL_ENABLED).
import './infra/observability/tracing';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { SocketAdapter } from './infra/socket/socket.adapter';

async function bootstrap(): Promise<void> {
  (BigInt.prototype as any).toJSON = function () {
    return Number(this);
  };

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

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
  app.enableShutdownHooks();

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
}

void bootstrap();
// Trigger restart to reload .env configuration changes
