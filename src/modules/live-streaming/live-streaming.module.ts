import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { InvestigationRecordingModule } from 'src/modules/investigation-recording/investigation-recording.module';
import { ModeratorPerformanceModule } from 'src/modules/moderator-performance/moderator-performance.module';
import { ModeratorShiftModule } from 'src/modules/moderator-shift/moderator-shift.module';
import { ModeratorWarningModule } from 'src/modules/moderator-warning/moderator-warning.module';
import { MobileWorkforceModule } from 'src/modules/mobile-workforce/mobile-workforce.module';
import { LiveStreamController } from './controllers/live-stream.controller';
import { LiveStreamingController } from './controllers/live-streaming.controller';
import { LiveStreamService } from './services/live-stream.service';
import { LiveStreamingService } from './services/live-streaming.service';

/**
 * Live Streaming domain — streams, participants, moderation & territory-scoped counts.
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
  controllers: [LiveStreamController, LiveStreamingController],
  providers: [LiveStreamService, LiveStreamingService, PrismaService],
  exports: [LiveStreamService, LiveStreamingService],
})
export class LiveStreamingModule {}
