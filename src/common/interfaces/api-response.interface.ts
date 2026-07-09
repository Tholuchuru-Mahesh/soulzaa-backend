import type { ErrorCode } from '../exceptions/error-codes';

/** Metadata attached to every response envelope. */
export interface ResponseMeta {
  requestId?: string;
  /** Active OpenTelemetry trace id, when tracing is enabled (trace↔support correlation). */
  traceId?: string;
  timestamp: string;
}

/** Standardized success envelope (ResponseInterceptor). */
export interface SuccessResponse<T> extends ResponseMeta {
  success: true;
  data: T;
}

/** A page of results carried inside a SuccessResponse.data. */
export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export type PaginatedResponse<T> = SuccessResponse<Paginated<T>>;

/** Standardized error envelope (AllExceptionsFilter). */
export interface ErrorResponse extends ResponseMeta {
  success: false;
  statusCode: number;
  errorCode?: ErrorCode;
  message: string | string[];
  error: string;
  path: string;
}
