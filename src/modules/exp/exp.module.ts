import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { ExpAdminController } from './controllers/exp-admin.controller';
import { ExpController } from './controllers/exp.controller';
import { LevelController } from './controllers/level.controller';
import { EXP_SERVICE } from './interfaces/exp.service.interface';
import { ExpActivityListener } from './listeners/exp-activity.listener';
import { ExpRepository } from './repositories/exp.repository';
import { ExpAdminService } from './services/exp-admin.service';
import { ExpConfigSeeder } from './services/exp-config.seeder.service';
import { ExpRewardGranter } from './services/exp-reward.granter';
import { ExpService } from './services/exp.service';
import { ExperienceHistoryService } from './services/experience-history.service';
import { ExperienceSourceService } from './services/experience-source.service';
import { ExperienceService } from './services/experience.service';
import { LevelAuditService } from './services/level-audit.service';
import { LevelCalculationService } from './services/level-calculation.service';
import { LevelConfigurationService } from './services/level-configuration.service';
import { LevelEventService } from './services/level-event.service';
import { LevelQueryService } from './services/level-query.service';
import { LevelService } from './services/level.service';
import { LevelStatisticsService } from './services/level-statistics.service';
import { LevelValidationService } from './services/level-validation.service';

@Global()
@Module({
  imports: [PlatformConfigurationModule],
  controllers: [ExpController, ExpAdminController, LevelController],
  providers: [
    ExpRepository,
    ExpRewardGranter,
    ExpService,
    ExpAdminService,
    ExpConfigSeeder,
    ExpActivityListener,
    { provide: EXP_SERVICE, useExisting: ExpService },
    // Phase 13 Enterprise Level & Experience Engine Services
    LevelConfigurationService,
    LevelValidationService,
    LevelCalculationService,
    ExperienceSourceService,
    ExperienceService,
    ExperienceHistoryService,
    LevelService,
    LevelAuditService,
    LevelStatisticsService,
    LevelQueryService,
    LevelEventService,
  ],
  exports: [
    EXP_SERVICE,
    LevelConfigurationService,
    LevelValidationService,
    LevelCalculationService,
    ExperienceSourceService,
    ExperienceService,
    ExperienceHistoryService,
    LevelService,
    LevelAuditService,
    LevelStatisticsService,
    LevelQueryService,
    LevelEventService,
  ],
})
export class ExpModule {}
