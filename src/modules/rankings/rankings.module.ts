import { Module } from '@nestjs/common';
import { RankingsController } from './controllers/rankings.controller';
import { RANKINGS_SERVICE } from './interfaces/rankings.service.interface';
import { RankingsActivityListener } from './listeners/rankings-activity.listener';
import { RankingsProcessor } from './processors/rankings.processor';
import { RankingsRepository } from './repositories/rankings.repository';
import { LeaderboardCache } from './services/leaderboard-cache.service';
import { LeaderboardStore } from './services/leaderboard-store.service';
import { RankingPeriodResolver } from './services/ranking-period.resolver';
import { RankingsService } from './services/rankings.service';
import { RankingsScheduler } from './services/rankings.scheduler';

// FAMILIES_SERVICE (used by RankingsService for family scoring) is resolved
// globally from the @Global FamiliesModule — no module import needed.
@Module({
  controllers: [RankingsController],
  providers: [
    // ---- generic ranking core (no domain knowledge; consumed by VR-13) ----
    RankingPeriodResolver,
    LeaderboardStore,
    LeaderboardCache,
    RankingsRepository,
    RankingsService,
    RankingsActivityListener,
    RankingsScheduler,
    RankingsProcessor,
    {
      provide: RANKINGS_SERVICE,
      useClass: RankingsService,
    },
  ],
  exports: [
    RankingsRepository,
    RankingsService,
    RANKINGS_SERVICE,
    RankingPeriodResolver,
    LeaderboardStore,
    LeaderboardCache,
  ],
})
export class RankingsModule {}
