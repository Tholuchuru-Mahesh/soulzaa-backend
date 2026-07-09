import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Manual span helpers for instrumenting critical business operations (e.g. a
 * gift send, a wallet debit, a PK settlement) on top of the auto-instrumentation
 * set up in `tracing.ts`.
 *
 * Safe when tracing is disabled: `@opentelemetry/api` returns a no-op tracer, so
 * `withSpan` simply runs the function and `currentTraceId` returns undefined —
 * no dependency on whether the SDK started.
 */
const tracer = trace.getTracer('soulzaa-backend');

/** Run `fn` inside a span, recording exceptions and setting OK/ERROR status. */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    if (attributes) span.setAttributes(attributes);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** The active trace id (32-hex) for correlating logs/responses, or undefined. */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const { traceId } = span.spanContext();
  // All-zero trace id means no real (sampled) trace is active.
  return traceId && traceId !== '0'.repeat(32) ? traceId : undefined;
}
