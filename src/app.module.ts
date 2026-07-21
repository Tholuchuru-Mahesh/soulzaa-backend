import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from './infra/observability/logger.module';
import { AppController } from './app.controller';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { EventBusModule } from './common/events/event-bus.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permission.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { configurations } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { ContentModerationModule } from './infra/content-moderation';
import { InfraModule } from './infra/infra.module';
import { MetricsInterceptor } from './infra/observability/metrics.interceptor';
import { DOMAIN_MODULES } from './modules';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: configurations,
      validate: validateEnv,
    }),
    LoggerModule,
    EventBusModule,
    InfraModule,
    ContentModerationModule,
    ...DOMAIN_MODULES,
  ],
  controllers: [AppController],
  providers: [
    // Global JWT auth (routes opt out with @Public), then role + permission checks.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Metrics first (outermost), then success-envelope wrapping.
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    // Consistent error envelope.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
