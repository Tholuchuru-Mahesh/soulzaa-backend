import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';

/** Probe/scrape endpoints excluded from per-request access logging. */
const LOG_IGNORED_PATHS = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/health/startup',
  '/metrics',
]);

/**
 * Structured logging config (pino). Pretty in dev, JSON in prod. Adds a
 * per-request correlation id, attaches user/request context, and redacts
 * sensitive headers. Slow-request warnings are emitted by SlowRequestInterceptor.
 */
export function buildLoggerConfig(): Params {
  const isProd = process.env.NODE_ENV === 'production';
  const level = process.env.LOG_LEVEL ?? 'info';

  return {
    pinoHttp: {
      level,
      genReqId: (req, res) => {
        const existing = req.headers['x-request-id'];
        const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Attach request/user context to every completed-request log. `req.user`
      // is populated by the auth guards before pino-http logs on response finish.
      customProps: (req) => {
        const user = (req as { user?: { id?: string } }).user;
        return { requestId: (req as { id?: string }).id, userId: user?.id };
      },
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        remove: true,
      },
      autoLogging: {
        ignore: (req) => LOG_IGNORED_PATHS.has(req.url ?? ''),
      },
    },
  };
}
