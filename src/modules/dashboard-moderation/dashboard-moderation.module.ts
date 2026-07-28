import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { DashboardModerationController } from './controllers/dashboard-moderation.controller';
import { DashboardModerationService } from './services/dashboard-moderation.service';

/**
 * Moderation section of the web admin console: the moderation dashboard (report
 * queue, appeals, enforcement volume) and operational logs.
 *
 * Read-only aggregation — no business logic of its own.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DashboardModerationController],
  providers: [DashboardModerationService],
  exports: [DashboardModerationService],
})
export class DashboardModerationModule {}
