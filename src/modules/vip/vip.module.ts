import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { VipAdminController } from './controllers/vip-admin.controller';
import { VipController } from './controllers/vip.controller';
import { VIP_SERVICE } from './interfaces/vip.service.interface';
import { VipRechargeListener } from './listeners/vip-recharge.listener';
import { VipRepository } from './repositories/vip.repository';
import {
  VipAuditService,
  VipBenefitService,
  VipConfigurationService,
  VipEventService,
  VipHistoryService,
  VipMembershipService,
  VipQueryService,
  VipRewardService,
  VipStatisticsService,
  VipSubscriptionService,
  VipTierService,
  VipValidationService,
} from './services';
import { VipAdminService } from './services/vip-admin.service';
import { VipConfigSeeder } from './services/vip-config.seeder.service';
import { VipService } from './services/vip.service';

@Global()
@Module({
  imports: [PlatformConfigurationModule, WalletModule],
  controllers: [VipController, VipAdminController],
  providers: [
    VipRepository,
    VipService,
    VipAdminService,
    VipConfigSeeder,
    VipRechargeListener,
    { provide: VIP_SERVICE, useExisting: VipService },
    VipConfigurationService,
    VipValidationService,
    VipTierService,
    VipBenefitService,
    VipRewardService,
    VipSubscriptionService,
    VipMembershipService,
    VipHistoryService,
    VipAuditService,
    VipStatisticsService,
    VipQueryService,
    VipEventService,
  ],
  exports: [
    VIP_SERVICE,
    VipConfigurationService,
    VipValidationService,
    VipTierService,
    VipBenefitService,
    VipRewardService,
    VipSubscriptionService,
    VipMembershipService,
    VipHistoryService,
    VipAuditService,
    VipStatisticsService,
    VipQueryService,
    VipEventService,
  ],
})
export class VipModule {}
