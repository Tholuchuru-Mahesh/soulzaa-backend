import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { InvestigationRecordingModule } from 'src/modules/investigation-recording/investigation-recording.module';
import { ModerationApprovalModule } from 'src/modules/moderation-approval/moderation-approval.module';
import { ModeratorPerformanceModule } from 'src/modules/moderator-performance/moderator-performance.module';
import { ModeratorShiftModule } from 'src/modules/moderator-shift/moderator-shift.module';
import { ModeratorWarningModule } from 'src/modules/moderator-warning/moderator-warning.module';
import { MobileWorkforceModule } from 'src/modules/mobile-workforce/mobile-workforce.module';
import { LiveStreamController } from './controllers/live-stream.controller';
import { LiveStreamingController } from './controllers/live-streaming.controller';
import { LiveStreamModerationRepository } from './repositories/live-stream-moderation.repository';
import { LiveStreamReportRepository } from './repositories/live-stream-report.repository';
import { LiveStreamReportService } from './services/live-stream-report.service';
import { LiveStreamService } from './services/live-stream.service';
import { LiveStreamingService } from './services/live-streaming.service';
import { LiveStreamModerationApprovalListener } from './listeners/live-stream-moderation-approval.listener';

/**
 * Live Streaming domain — streams, participants, moderation & territory-scoped counts.
 *
 * `SocketManager`/`PresenceService` come from the globally-registered
 * `SocketModule`/`RedisModule` — no import needed here.
 */
@Module({
  imports: [
    PrismaModule,
    InvestigationRecordingModule,
    ModerationApprovalModule,
    ModeratorPerformanceModule,
    ModeratorShiftModule,
    ModeratorWarningModule,
    MobileWorkforceModule,
  ],
  controllers: [LiveStreamController, LiveStreamingController],
  providers: [
    LiveStreamService,
    LiveStreamingService,
    LiveStreamModerationRepository,
    LiveStreamReportRepository,
    LiveStreamReportService,
    LiveStreamModerationApprovalListener,
    PrismaService,
  ],
  exports: [LiveStreamService, LiveStreamingService, LiveStreamReportService],
})
export class LiveStreamingModule {}
