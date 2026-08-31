import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { ContributionsAdminController } from './controllers/contributions-admin.controller';
import { WeeklyContributionRepository } from './repositories/weekly-contribution.repository';
import { WeeklyContributionRolloverScheduler } from './services/weekly-contribution-rollover.scheduler';
import { WeeklyContributionService } from './services/weekly-contribution.service';

/**
 * Weekly room-contribution reporting + lifecycle. The write path (per-week
 * bucket increments) lives with the counters in `TreasureRepository`; this
 * module owns the Super Admin read APIs and the Monday-00:00-UTC rollover
 * broadcast that resets live rooms with no manual refresh.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ContributionsAdminController],
  providers: [
    WeeklyContributionRepository,
    WeeklyContributionService,
    WeeklyContributionRolloverScheduler,
  ],
  exports: [WeeklyContributionRepository],
})
export class ContributionsModule {}
