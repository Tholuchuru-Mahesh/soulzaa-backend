import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { WorkforceScopeService } from './services/workforce-scope.service';

/**
 * `WorkforceScopeService` split out of `MobileWorkforceModule` so the audio/
 * video/live-stream moderation modules — and `ModerationApprovalModule` and
 * `InvestigationRecordingModule` — can depend on just the scope service
 * without importing the whole mobile-workforce module. `MobileWorkforceModule`
 * needs to import those same modules for its Reports façade (Task 3+), and
 * Nest module imports can't form a cycle — this is the break point.
 */
@Module({
  imports: [PrismaModule],
  providers: [WorkforceScopeService],
  exports: [WorkforceScopeService],
})
export class WorkforceScopeModule {}
