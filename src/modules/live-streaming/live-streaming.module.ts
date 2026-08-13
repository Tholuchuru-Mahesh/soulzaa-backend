import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { InvestigationRecordingModule } from 'src/modules/investigation-recording/investigation-recording.module';
import { ModeratorPerformanceModule } from 'src/modules/moderator-performance/moderator-performance.module';
import { ModeratorShiftModule } from 'src/modules/moderator-shift/moderator-shift.module';
import { ModeratorWarningModule } from 'src/modules/moderator-warning/moderator-warning.module';
import { MobileWorkforceModule } from 'src/modules/mobile-workforce/mobile-workforce.module';
import { LiveStreamController } from './controllers/live-stream.controller';
import { LiveStreamService } from './services/live-stream.service';

/**
 * Live Streaming domain — streams, participants, moderation.
 * Phase 1 implementation with live stream lifecycle & moderation tools.
 */
@Module({
  imports: [
    PrismaModule,
    InvestigationRecordingModule,
    ModeratorPerformanceModule,
    ModeratorShiftModule,
    ModeratorWarningModule,
    MobileWorkforceModule,
  ],
  controllers: [LiveStreamController],
  providers: [LiveStreamService],
  exports: [LiveStreamService],
})
export class LiveStreamingModule {}

