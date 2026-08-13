import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import {
  ModeratorPerformanceSelfController,
  ModeratorPerformanceAdminController,
} from './controllers/moderator-performance.controller';
import { ModeratorPerformanceService } from './services/moderator-performance.service';

@Module({
  imports: [PrismaModule],
  controllers: [ModeratorPerformanceSelfController, ModeratorPerformanceAdminController],
  providers: [ModeratorPerformanceService],
  exports: [ModeratorPerformanceService],
})
export class ModeratorPerformanceModule {}
