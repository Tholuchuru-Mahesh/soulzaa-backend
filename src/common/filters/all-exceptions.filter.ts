import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { currentTraceId } from 'src/infra/observability/trace.util';
import type { ErrorCode } from '../exceptions/error-codes';
import type { ErrorResponse } from '../interfaces/api-response.interface';

/**
 * Turns any thrown error into a consistent JSON envelope. Known HttpExceptions
 * keep their status/message; BusinessExceptions also surface their errorCode;
 * everything else becomes a 500 with the details logged server-side (never
 * leaked to the client). Includes the per-request correlation id (x-request-id).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'InternalServerError';
    let errorCode: ErrorCode | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        const body = res as Record<string, unknown>;
        message = (body.message as string | string[]) ?? exception.message;
        error = (body.error as string) ?? exception.name;
        errorCode = body.errorCode as ErrorCode | undefined;
      }
      error = error === 'InternalServerError' ? exception.name : error;
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled: ${exception.message}`, exception.stack);
    }

    const traceId = currentTraceId();
    const envelope: ErrorResponse = {
      success: false,
      statusCode: status,
      ...(errorCode ? { errorCode } : {}),
      message,
      error,
      path: request.url,
      requestId: request.id,
      ...(traceId ? { traceId } : {}),
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(envelope);
  }
}
