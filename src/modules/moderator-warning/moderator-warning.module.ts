import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import {
  ModeratorWarningController,
  MyWarningsController,
} from './controllers/moderator-warning.controller';
import { ModeratorWarningService } from './services/moderator-warning.service';
import { SuspendedGuard } from './guards/suspended.guard';
import { ModeratorPerformanceModule } from 'src/modules/moderator-performance/moderator-performance.module';

@Module({
  imports: [PrismaModule, ModeratorPerformanceModule],
  controllers: [ModeratorWarningController, MyWarningsController],
  providers: [ModeratorWarningService, SuspendedGuard],
  exports: [ModeratorWarningService, SuspendedGuard],
})
export class ModeratorWarningModule {}
