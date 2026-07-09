import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from './error-codes';

/**
 * A domain/business rule violation. Carries a machine-readable `errorCode`
 * that AllExceptionsFilter surfaces in the error envelope. Domain modules throw
 * this (or a subclass) instead of a bare HttpException when the client needs to
 * branch on the specific failure.
 */
export class BusinessException extends HttpException {
  constructor(
    readonly errorCode: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super({ message, error: errorCode, errorCode }, status);
  }
}
