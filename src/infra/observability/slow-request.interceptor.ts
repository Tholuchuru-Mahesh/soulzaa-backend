import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Emits a structured `warn` when an HTTP request exceeds the slow-request
 * threshold (SLOW_REQUEST_MS). Complements pino-http's per-request access log,
 * which logs everything at info.
 */
@Injectable()
export class SlowRequestInterceptor implements NestInterceptor {
  private readonly thresholdMs: number;

  constructor(
    private readonly logger: PinoLogger,
    config: ConfigService,
  ) {
    this.logger.setContext('SlowRequest');
    this.thresholdMs = Number(config.get('monitoring', { infer: true })!.slowRequestMs);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context
      .switchToHttp()
      .getRequest<Request & { id?: string; user?: { id?: string } }>();
    const res = context.switchToHttp().getResponse<Response>();
    const startedAt = Date.now();

    const check = (): void => {
      const durationMs = Date.now() - startedAt;
      if (durationMs > this.thresholdMs) {
        this.logger.warn(
          {
            requestId: req.id,
            userId: req.user?.id,
            method: req.method,
            url: req.originalUrl ?? req.url,
            statusCode: res.statusCode,
            durationMs,
          },
          `slow request: ${req.method} ${req.url} took ${durationMs}ms`,
        );
      }
    };

    return next.handle().pipe(tap({ next: check, error: check }));
  }
}
