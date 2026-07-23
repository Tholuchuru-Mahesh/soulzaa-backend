import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { AgencySettlementController } from './controllers/agency-settlement.controller';
import {
  AgencyAuditService,
  AgencyCommissionService,
  AgencyConfigurationService,
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
  controllers: [AgencySettlementController],
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
  ],
})
export class AgenciesModule {}
