import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { MobileWorkforceController } from './controllers/mobile-workforce.controller';
import { ModeratorLiveMonitoringController } from './controllers/moderator-live-monitoring.controller';
import { MobileWorkforceService } from './services/mobile-workforce.service';
import { WorkforceScopeModule } from './workforce-scope.module';

import { ModeratorShiftModule } from 'src/modules/moderator-shift/moderator-shift.module';
import { ModeratorWarningModule } from 'src/modules/moderator-warning/moderator-warning.module';
import { LiveStreamingModule } from 'src/modules/live-streaming/live-streaming.module';
import { InvestigationRecordingModule } from 'src/modules/investigation-recording/investigation-recording.module';
import { PlatformModerationModule } from 'src/modules/platform-moderation/platform-moderation.module';

/**
 * Mobile console for the operational workforce — Country Manager, Official and
 * Moderator. Business Development is intentionally not wired up yet.
 *
 * Read-only and geographically scoped: `WorkforceScopeService` narrows every
 * query to the caller's assigned territory.
 *
 * The Reports façade (see `MobileWorkforceService.actionReport`/`reportDetails`)
 * delegates to the authoritative per-room-type moderation services. Audio/Video
 * are `@Global()` (`AudioRoomsModule`/`VideoRoomsModule`) so their exports are
 * ambient — no explicit import needed. Live-streaming and investigation
 * recording are not global, so they're imported explicitly here; this only
 * works because both of them (and `ModerationApprovalModule`, which they in
 * turn import) now depend on `WorkforceScopeModule` rather than this module —
 * see `WorkforceScopeModule`'s doc comment for why that split exists.
 */
@Module({
  imports: [
    PrismaModule,
    ModeratorShiftModule,
    ModeratorWarningModule,
    WorkforceScopeModule,
    LiveStreamingModule,
    InvestigationRecordingModule,
    PlatformModerationModule,
  ],
  controllers: [MobileWorkforceController, ModeratorLiveMonitoringController],
  providers: [MobileWorkforceService],
  exports: [MobileWorkforceService, WorkforceScopeModule],
})
export class MobileWorkforceModule {}
