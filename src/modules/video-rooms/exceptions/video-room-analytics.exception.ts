import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';

export class AnalyticsException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super(ERROR_CODES.ANALYTICS_NOT_AUTHORIZED, message, status);
  }
}

export class AggregationException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR) {
    super(ERROR_CODES.INTERNAL, message, status);
  }
}

export class AnalyticsCacheException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR) {
    super(ERROR_CODES.INTERNAL, message, status);
  }
}

export class AnalyticsSnapshotException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR) {
    super(ERROR_CODES.INTERNAL, message, status);
  }
}
