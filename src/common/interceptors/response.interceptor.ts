import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { SuccessResponse } from '../interfaces/api-response.interface';

/** @deprecated use SuccessResponse. Kept for backward-compatible imports. */
export type SuccessEnvelope<T> = SuccessResponse<T>;

/** Marker to skip envelope wrapping (e.g. /metrics, health, raw streams). */
export const RAW_RESPONSE_KEY = 'rawResponse';

/**
 * Wraps successful HTTP responses in a consistent { success, data, requestId }
 * envelope, matching the error envelope from AllExceptionsFilter. Already-enveloped
 * or raw responses pass through untouched. The requestId reuses pino's per-request
 * correlation id (x-request-id).
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, SuccessResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<SuccessResponse<T> | T> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request & { id?: string }>();

    return next.handle().pipe(
      map((data) => {
        if (raw) return data;
        if (data && typeof data === 'object' && 'success' in (data as object)) {
          return data; // already enveloped
        }
        return {
          success: true,
          data,
          requestId: req.id,
          timestamp: new Date().toISOString(),
        } as SuccessResponse<T>;
      }),
    );
  }
}
