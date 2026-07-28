import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { DashboardOperationsController } from './controllers/dashboard-operations.controller';
import { DashboardOperationsService } from './services/dashboard-operations.service';

/**
 * Operations section of the web admin console: platform overview, user overview,
 * events management, task & mission management, notification centre and the
 * analytics dashboard.
 *
 * Read-only aggregation — no business logic of its own.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DashboardOperationsController],
  providers: [DashboardOperationsService],
  exports: [DashboardOperationsService],
})
export class DashboardOperationsModule {}
