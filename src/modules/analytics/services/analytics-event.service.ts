import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

export interface AnalyticsEventPayload {
  reportId?: string;
  dashboardId?: string;
  exportId?: string;
  domain?: string;
  metricKey?: string;
  metricValue?: number;
  actorId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AnalyticsEventService {
  private readonly logger = new Logger(AnalyticsEventService.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  emitSnapshotCreated(payload: AnalyticsEventPayload): void {
    this.eventEmitter.emit('analytics.snapshot.created', payload);
    this.logger.log(`Event: analytics.snapshot.created — domain: ${payload.domain} — key: ${payload.metricKey}`);
  }

  emitReportGenerated(payload: AnalyticsEventPayload): void {
    this.eventEmitter.emit('report.generated', payload);
    this.logger.log(`Event: report.generated — id: ${payload.reportId}`);
  }

  emitReportExported(payload: AnalyticsEventPayload): void {
    this.eventEmitter.emit('report.exported', payload);
    this.logger.log(`Event: report.exported — id: ${payload.exportId} — format: ${payload.metadata?.format}`);
  }

  emitDashboardRefreshed(payload: AnalyticsEventPayload): void {
    this.eventEmitter.emit('dashboard.refreshed', payload);
    this.logger.log(`Event: dashboard.refreshed — id: ${payload.dashboardId}`);
  }
}
