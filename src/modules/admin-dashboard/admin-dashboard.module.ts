import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { DashboardController } from './controllers/dashboard.controller';
import { AdminDashboardService } from './services/admin-dashboard.service';
import { DashboardWidgetService } from './services/dashboard-widget.service';
import { DashboardStatisticsService } from './services/dashboard-statistics.service';
import { DashboardQueryService } from './services/dashboard-query.service';
import { DashboardAuditService } from './services/dashboard-audit.service';
import { DashboardConfigurationService } from './services/dashboard-configuration.service';
import { DashboardHealthService } from './services/dashboard-health.service';
import { DashboardExportService } from './services/dashboard-export.service';
import { DashboardValidationService } from './services/dashboard-validation.service';
import { DashboardEventService } from './services/dashboard-event.service';

const SERVICES = [
  AdminDashboardService,
  DashboardWidgetService,
  DashboardStatisticsService,
  DashboardQueryService,
  DashboardAuditService,
  DashboardConfigurationService,
  DashboardHealthService,
  DashboardExportService,
  DashboardValidationService,
  DashboardEventService,
];

@Module({
  imports: [PrismaModule],
  controllers: [DashboardController],
  providers: [...SERVICES],
  exports: [...SERVICES],
})
export class AdminDashboardModule {}
