import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { buildLoggerConfig } from './logger.config';
import { SlowRequestInterceptor } from './slow-request.interceptor';

/**
 * Structured request logging (pino): correlation ids, redaction, user/request
 * context, and slow-request warnings. Wraps nestjs-pino so the rest of the app
 * imports one module. Global so PinoLogger is injectable everywhere.
 */
@Global()
@Module({
  imports: [PinoLoggerModule.forRoot(buildLoggerConfig())],
  providers: [{ provide: APP_INTERCEPTOR, useClass: SlowRequestInterceptor }],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
