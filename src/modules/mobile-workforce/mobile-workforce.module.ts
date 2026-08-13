import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { MobileWorkforceController } from './controllers/mobile-workforce.controller';
import { ModeratorLiveMonitoringController } from './controllers/moderator-live-monitoring.controller';
import { MobileWorkforceService } from './services/mobile-workforce.service';
import { WorkforceScopeService } from './services/workforce-scope.service';

import { ModeratorShiftModule } from 'src/modules/moderator-shift/moderator-shift.module';

/**
 * Mobile console for the operational workforce — Country Manager, Official and
 * Moderator. Business Development is intentionally not wired up yet.
 *
 * Read-only and geographically scoped: `WorkforceScopeService` narrows every
 * query to the caller's assigned territory.
 */
@Module({
  imports: [PrismaModule, ModeratorShiftModule],
  controllers: [MobileWorkforceController, ModeratorLiveMonitoringController],
  providers: [MobileWorkforceService, WorkforceScopeService],
  exports: [MobileWorkforceService, WorkforceScopeService],
})
export class MobileWorkforceModule {}
