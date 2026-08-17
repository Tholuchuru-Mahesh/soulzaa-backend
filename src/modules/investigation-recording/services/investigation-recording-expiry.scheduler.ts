import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InvestigationRecordingService } from './investigation-recording.service';

/**
 * Sweeps join-triggered investigation recordings a Moderator opened but
 * never concluded (left the room, shift ended) so they don't stay ACTIVE
 * forever. See `InvestigationRecordingService.expireStaleRecordings`.
 */
@Injectable()
export class InvestigationRecordingExpiryScheduler {
  private readonly logger = new Logger(InvestigationRecordingExpiryScheduler.name);

  constructor(private readonly recordings: InvestigationRecordingService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleStaleRecordings(): Promise<void> {
    try {
      await this.recordings.expireStaleRecordings();
    } catch (err) {
      this.logger.error(
        `Failed to sweep stale investigation recordings: ${(err as Error).message}`,
      );
    }
  }
}
