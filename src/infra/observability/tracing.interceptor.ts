import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { TracingService } from './tracing.service';

@Injectable()
export class TracingInterceptor implements NestInterceptor {
  constructor(private readonly tracingService: TracingService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    if (!req) return next.handle();

    const controllerName = context.getClass().name;
    const handlerName = context.getHandler().name;
    const operation = `${controllerName}.${handlerName}`;

    const spanContext = this.tracingService.startSpan(operation, {
      traceId: req.headers['x-trace-id'] as string,
      correlationId: req.headers['x-correlation-id'] as string,
      userId: req.user?.id,
    });

    req.headers['x-trace-id'] = spanContext.traceId;
    req.headers['x-span-id'] = spanContext.spanId;

    const res = context.switchToHttp().getResponse();
    if (res && res.setHeader) {
      res.setHeader('x-trace-id', spanContext.traceId);
      res.setHeader('x-span-id', spanContext.spanId);
    }

    return next.handle().pipe(
      tap({
        next: () => {
          this.tracingService.endSpan(spanContext, { status: 'SUCCESS' });
        },
        error: (err) => {
          this.tracingService.endSpan(spanContext, { status: 'ERROR', error: err?.message });
        },
      }),
    );
  }
}
