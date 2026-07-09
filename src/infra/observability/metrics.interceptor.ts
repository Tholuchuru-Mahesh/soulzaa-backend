import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/** Records request count + duration for every HTTP request. */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const end = this.metrics.httpDuration.startTimer();
    const route = (req.route?.path as string) ?? req.path;

    return next.handle().pipe(
      tap({
        next: () => this.record(req.method, route, res.statusCode, end),
        error: () => this.record(req.method, route, res.statusCode || 500, end),
      }),
    );
  }

  private record(method: string, route: string, status: number, end: (labels: any) => void): void {
    const labels = { method, route, status: String(status) };
    this.metrics.httpRequests.inc(labels);
    end(labels);
  }
}
