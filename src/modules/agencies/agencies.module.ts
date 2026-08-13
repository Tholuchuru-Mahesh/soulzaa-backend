import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { AgencyDashboardController } from './controllers/agency-dashboard.controller';
import { AgencySettlementController } from './controllers/agency-settlement.controller';
import {
  AgencyAuditService,
  AgencyCommissionService,
  AgencyCommunityService,
  AgencyConfigurationService,
  AgencyDashboardService,
  AgencyEventService,
  AgencyHistoryService,
  AgencyQueryService,
  AgencyRelationshipService,
  AgencySettlementService,
  AgencyStatisticsService,
  AgencyValidationService,
} from './services';

@Global()
@Module({
  imports: [PlatformConfigurationModule, TreasuryModule, WalletModule],
  controllers: [AgencySettlementController, AgencyDashboardController],
  providers: [
    AgencyConfigurationService,
    AgencyCommissionService,
    AgencyRelationshipService,
    AgencyValidationService,
    AgencySettlementService,
    AgencyHistoryService,
    AgencyAuditService,
    AgencyStatisticsService,
    AgencyQueryService,
    AgencyEventService,
    AgencyCommunityService,
    AgencyDashboardService,
  ],
  exports: [
    AgencyConfigurationService,
    AgencyCommissionService,
    AgencyRelationshipService,
    AgencyValidationService,
    AgencySettlementService,
    AgencyHistoryService,
    AgencyAuditService,
    AgencyStatisticsService,
    AgencyQueryService,
    AgencyEventService,
    AgencyCommunityService,
    AgencyDashboardService,
  ],
})
export class AgenciesModule {}
