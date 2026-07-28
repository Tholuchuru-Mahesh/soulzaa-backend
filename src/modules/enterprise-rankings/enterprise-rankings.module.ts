import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { QueueModule } from 'src/infra/queue/queue.module';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { RankingsModule } from 'src/modules/rankings/rankings.module';
import { ENTERPRISE_RANKING_QUEUES } from './constants/ranking-jobs.constants';
import { EnterpriseRankingController } from './controllers/ranking.controller';
import { EnterpriseRankingProcessor } from './processors/ranking.processor';
import { RankingScheduler } from './services/ranking.scheduler';
import { LeaderboardService } from './services/leaderboard.service';
import { RankingAggregationService } from './services/ranking-aggregation.service';
import { RankingAuditService } from './services/ranking-audit.service';
import { RankingCalculationService } from './services/ranking-calculation.service';
import { RankingConfigurationService } from './services/ranking-configuration.service';
import { RankingEventService } from './services/ranking-event.service';
import { RankingQueryService } from './services/ranking-query.service';
import { RankingService } from './services/ranking.service';
import { RankingSnapshotService } from './services/ranking-snapshot.service';
import { RankingStatisticsService } from './services/ranking-statistics.service';
import { RankingValidationService } from './services/ranking-validation.service';
import { RankingProgressionListener } from './listeners/ranking-progression.listener';

@Global()
@Module({
  imports: [
    PlatformConfigurationModule,
    RankingsModule,
    QueueModule,
    BullModule.registerQueue({ name: ENTERPRISE_RANKING_QUEUES.SNAPSHOT }),
  ],
  controllers: [EnterpriseRankingController],
  providers: [
    // Phase 15: Enterprise Ranking Engine Services
    RankingProgressionListener,
    RankingScheduler,
    EnterpriseRankingProcessor,
    RankingConfigurationService,
    RankingValidationService,
    RankingAuditService,
    RankingEventService,
    RankingStatisticsService,
    RankingCalculationService,
    RankingAggregationService,
    RankingSnapshotService,
    RankingService,
    LeaderboardService,
    RankingQueryService,
  ],
  exports: [
    RankingConfigurationService,
    RankingValidationService,
    RankingAuditService,
    RankingEventService,
    RankingStatisticsService,
    RankingCalculationService,
    RankingAggregationService,
    RankingSnapshotService,
    RankingService,
    LeaderboardService,
    RankingQueryService,
  ],
})
export class EnterpriseRankingsModule {}
