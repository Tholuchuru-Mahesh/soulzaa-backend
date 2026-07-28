import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { MobileWorkforceController } from './controllers/mobile-workforce.controller';
import { MobileWorkforceService } from './services/mobile-workforce.service';
import { WorkforceScopeService } from './services/workforce-scope.service';

/**
 * Mobile console for the operational workforce — Country Manager, Official and
 * Moderator. Business Development is intentionally not wired up yet.
 *
 * Read-only and geographically scoped: `WorkforceScopeService` narrows every
 * query to the caller's assigned territory.
 */
@Module({
  imports: [PrismaModule],
  controllers: [MobileWorkforceController],
  providers: [MobileWorkforceService, WorkforceScopeService],
  exports: [MobileWorkforceService, WorkforceScopeService],
})
export class MobileWorkforceModule {}
