import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { DashboardEngagementController } from './controllers/dashboard-engagement.controller';
import { DashboardEngagementService } from './services/dashboard-engagement.service';

/**
 * Engagement section of the web admin console: gift analytics, treasure box
 * monitoring, family management, VIP management, level & achievement monitoring,
 * the ranking dashboard and referral management.
 *
 * Read-only aggregation — no business logic of its own.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DashboardEngagementController],
  providers: [DashboardEngagementService],
  exports: [DashboardEngagementService],
})
export class DashboardEngagementModule {}
