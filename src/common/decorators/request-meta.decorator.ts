import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestMetadata } from '../interfaces/request-metadata.interface';

/** Injects per-request context (correlation id, client ip, user-agent, time). */
export const RequestMeta = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestMetadata => {
    const req = ctx.switchToHttp().getRequest<Request & { id?: string }>();
    return {
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString(),
    };
  },
);
