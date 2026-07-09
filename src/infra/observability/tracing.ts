/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * OpenTelemetry distributed-tracing bootstrap (AR-15).
 *
 * MUST be imported before any other module in `main.ts` so the Node SDK can
 * monkey-patch instrumented libraries (HTTP, Express, NestJS, ioredis, BullMQ,
 * Prisma, pino) as they load. Runs pre-Nest, so it reads raw `process.env`
 * (config/validation haven't initialised yet) and logs via `console`.
 *
 * Disabled by default — a no-op unless `OTEL_ENABLED=true`, so dev/test and any
 * environment without a collector pay zero cost (the heavy SDK packages are only
 * `require`d when enabled). Spans export over OTLP/HTTP to a collector
 * (Jaeger/Tempo/Grafana Agent); the pino instrumentation injects `trace_id` /
 * `span_id` into every log line for trace↔log correlation.
 */

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'soulzaa-backend';

function tracingEnabled(): boolean {
  return process.env.OTEL_ENABLED === 'true';
}

function startTracing(): void {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const {
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
  } = require('@opentelemetry/semantic-conventions');
  const { PrismaInstrumentation } = require('@prisma/instrumentation');

  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(
    /\/$/,
    '',
  );
  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_RATIO ?? '1');

  // Parent-based ratio sampling, configured via the standard env vars the SDK
  // reads: keep sampled traces from upstream, sample new roots at `ratio`.
  process.env.OTEL_TRACES_SAMPLER ??= 'parentbased_traceidratio';
  process.env.OTEL_TRACES_SAMPLER_ARG ??= String(Number.isFinite(ratio) ? ratio : 1);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]:
        process.env.OTEL_SERVICE_VERSION ?? process.env.npm_package_version ?? '0.0.0',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Silence high-cardinality/low-value instrumentations.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
      // Prisma query engine spans (GA in Prisma 6 — no preview flag needed).
      new PrismaInstrumentation(),
    ],
  });

  sdk.start();
  console.log(
    `[tracing] OpenTelemetry started (service=${SERVICE_NAME}, endpoint=${endpoint}, sampler=${process.env.OTEL_TRACES_SAMPLER_ARG})`,
  );

  // Best-effort flush on shutdown; Nest's own shutdown hooks handle process exit.
  const flush = (): void => {
    void sdk.shutdown().catch((err: unknown) => {
      console.error('[tracing] shutdown error:', (err as Error).message);
    });
  };
  process.once('SIGTERM', flush);
  process.once('SIGINT', flush);
}

if (tracingEnabled()) {
  try {
    startTracing();
  } catch (err) {
    // Tracing must never block the app from starting.
    console.error('[tracing] failed to start OpenTelemetry:', (err as Error).message);
  }
} else {
  console.log('[tracing] OpenTelemetry disabled (set OTEL_ENABLED=true to enable)');
}
