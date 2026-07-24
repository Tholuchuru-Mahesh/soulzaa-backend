import { Injectable, Logger } from '@nestjs/common';

export interface ExceptionRecord {
  type: string;
  message: string;
  module?: string;
  timestamp: string;
}

@Injectable()
export class ExceptionAnalyticsService {
  private readonly logger = new Logger(ExceptionAnalyticsService.name);
  private readonly errorCounts = new Map<string, number>();
  private readonly recentErrors: ExceptionRecord[] = [];

  recordException(error: Error | any, module?: string): void {
    const type = error?.name ?? error?.constructor?.name ?? 'UnknownError';
    const message = error?.message ?? String(error);
    const count = this.errorCounts.get(type) ?? 0;
    this.errorCounts.set(type, count + 1);

    const record: ExceptionRecord = {
      type,
      message,
      module,
      timestamp: new Date().toISOString(),
    };

    this.recentErrors.unshift(record);
    if (this.recentErrors.length > 100) {
      this.recentErrors.pop();
    }
  }

  getAnalytics() {
    const countsObj: Record<string, number> = {};
    this.errorCounts.forEach((val, key) => {
      countsObj[key] = val;
    });

    return {
      summary: countsObj,
      recent: this.recentErrors.slice(0, 20),
    };
  }
}
