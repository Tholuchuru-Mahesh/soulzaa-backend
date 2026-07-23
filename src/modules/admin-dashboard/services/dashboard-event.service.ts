import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

export interface DashboardEventPayload {
  widgetId?: string;
  layoutId?: string;
  userId?: string;
  exportId?: string;
  alertId?: string;
  severity?: string;
  title?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class DashboardEventService {
  private readonly logger = new Logger(DashboardEventService.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  emitWidgetUpdated(payload: DashboardEventPayload): void {
    this.eventEmitter.emit('dashboard.widget.updated', payload);
    this.logger.log(`Event: dashboard.widget.updated — id: ${payload.widgetId}`);
  }

  emitLayoutUpdated(payload: DashboardEventPayload): void {
    this.eventEmitter.emit('dashboard.layout.updated', payload);
    this.logger.log(`Event: dashboard.layout.updated — user: ${payload.userId}`);
  }

  emitExportGenerated(payload: DashboardEventPayload): void {
    this.eventEmitter.emit('dashboard.export.generated', payload);
    this.logger.log(`Event: dashboard.export.generated — id: ${payload.exportId}`);
  }

  emitAlertCreated(payload: DashboardEventPayload): void {
    this.eventEmitter.emit('dashboard.alert.created', payload);
    this.logger.log(`Event: dashboard.alert.created — [${payload.severity}] ${payload.title}`);
  }
}
