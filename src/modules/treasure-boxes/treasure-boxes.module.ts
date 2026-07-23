import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasureAdminController } from './controllers/treasure-admin.controller';
import { TreasureController } from './controllers/treasure.controller';
import { TREASURE_BOXES_SERVICE } from './interfaces/treasure-boxes.service.interface';
import { TreasureGiftListener } from './listeners/treasure-gift.listener';
import { RocketRepository } from './repositories/rocket.repository';
import { TreasureRepository } from './repositories/treasure.repository';
import {
  RewardDistributor,
  RocketExpiryMonitor,
  RocketService,
  TreasureAdminService,
  TreasureAuditService,
  TreasureBoxService,
  TreasureConfigSeeder,
  TreasureConfigurationService,
  TreasureDistributionService,
  TreasureEligibilityService,
  TreasureEventService,
  TreasureHistoryService,
  TreasureProgressService,
  TreasureResetService,
  TreasureRewardService,
  TreasureService,
} from './services';

@Global()
@Module({
  imports: [PlatformConfigurationModule],
  controllers: [TreasureController, TreasureAdminController],
  providers: [
    TreasureRepository,
    RocketRepository,
    RewardDistributor,
    TreasureService,
    RocketService,
    TreasureAdminService,
    TreasureConfigSeeder,
    TreasureGiftListener,
    RocketExpiryMonitor,
    TreasureConfigurationService,
    TreasureBoxService,
    TreasureProgressService,
    TreasureRewardService,
    TreasureEligibilityService,
    TreasureDistributionService,
    TreasureHistoryService,
    TreasureAuditService,
    TreasureEventService,
    TreasureResetService,
    { provide: TREASURE_BOXES_SERVICE, useExisting: TreasureService },
  ],
  exports: [
    TREASURE_BOXES_SERVICE,
    TreasureConfigurationService,
    TreasureBoxService,
    TreasureProgressService,
    TreasureRewardService,
    TreasureEligibilityService,
    TreasureDistributionService,
    TreasureHistoryService,
    TreasureAuditService,
    TreasureEventService,
    TreasureResetService,
  ],
})
export class TreasureBoxesModule {}
