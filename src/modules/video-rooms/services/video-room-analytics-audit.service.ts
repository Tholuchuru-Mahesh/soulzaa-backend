import { Injectable, Logger } from '@nestjs/common';
import { VideoRoomAnalyticsProjectionRepository } from '../repositories/video-room-analytics-projection.repository';

export interface AuditLogOptions {
  reportId?: string;
  actorId?: string;
  action: string;
  details?: Record<string, unknown>;
  executionTimeMs?: number;
}

@Injectable()
export class VideoRoomAnalyticsAuditService {
  private readonly logger = new Logger(VideoRoomAnalyticsAuditService.name);

  constructor(private readonly repository: VideoRoomAnalyticsProjectionRepository) {}

  async logAudit(options: AuditLogOptions): Promise<void> {
    try {
      const details = {
        ...options.details,
        executionTimeMs: options.executionTimeMs,
        timestamp: new Date().toISOString(),
      };

      await this.repository.createAudit({
        reportId: options.reportId,
        actorId: options.actorId,
        action: options.action,
        details,
      });
    } catch (err: any) {
      this.logger.error(`Failed to write analytics audit log: ${err.message}`);
    }
  }
}
