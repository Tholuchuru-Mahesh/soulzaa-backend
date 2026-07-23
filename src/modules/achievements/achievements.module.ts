import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { AchievementController } from './controllers/achievement.controller';
import { AchievementAuditService } from './services/achievement-audit.service';
import { AchievementConfigurationService } from './services/achievement-configuration.service';
import { AchievementEvaluationService } from './services/achievement-evaluation.service';
import { AchievementEventService } from './services/achievement-event.service';
import { AchievementProgressService } from './services/achievement-progress.service';
import { AchievementQueryService } from './services/achievement-query.service';
import { AchievementRewardService } from './services/achievement-reward.service';
import { AchievementService } from './services/achievement.service';
import { AchievementStatisticsService } from './services/achievement-statistics.service';
import { AchievementValidationService } from './services/achievement-validation.service';
import { BadgeService } from './services/badge.service';

@Global()
@Module({
  imports: [PlatformConfigurationModule],
  controllers: [AchievementController],
  providers: [
    // Phase 14: Enterprise Badge & Achievement Engine Services
    AchievementConfigurationService,
    AchievementValidationService,
    AchievementAuditService,
    AchievementEventService,
    AchievementStatisticsService,
    AchievementProgressService,
    AchievementRewardService,
    AchievementService,
    BadgeService,
    AchievementEvaluationService,
    AchievementQueryService,
  ],
  exports: [
    AchievementConfigurationService,
    AchievementValidationService,
    AchievementAuditService,
    AchievementEventService,
    AchievementStatisticsService,
    AchievementProgressService,
    AchievementRewardService,
    AchievementService,
    BadgeService,
    AchievementEvaluationService,
    AchievementQueryService,
  ],
})
export class AchievementsModule {}
