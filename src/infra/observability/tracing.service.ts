import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  correlationId?: string;
  userId?: string;
  roomId?: string;
  operation: string;
  startTime: number;
}

@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);

  startSpan(operation: string, parentContext?: Partial<TraceContext>): TraceContext {
    const traceId = parentContext?.traceId ?? crypto.randomBytes(16).toString('hex');
    const spanId = crypto.randomBytes(8).toString('hex');

    return {
      traceId,
      spanId,
      parentSpanId: parentContext?.spanId,
      correlationId: parentContext?.correlationId,
      userId: parentContext?.userId,
      roomId: parentContext?.roomId,
      operation,
      startTime: Date.now(),
    };
  }

  endSpan(context: TraceContext, attributes: Record<string, any> = {}): void {
    const durationMs = Date.now() - context.startTime;
    this.logger.debug(
      `[SpanEnd] ${context.operation} - ${durationMs}ms [traceId=${context.traceId}, spanId=${context.spanId}] ${JSON.stringify(
        attributes,
      )}`,
    );
  }
}
