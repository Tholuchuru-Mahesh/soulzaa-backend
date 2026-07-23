import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { RevenueController } from './controllers/revenue.controller';
import {
  HostEarningsService,
  RevenueAuditService,
  RevenueCalculationService,
  RevenueConfigurationService,
  RevenueDistributionService,
  RevenueEventService,
  RevenueHistoryService,
  RevenueQueryService,
  RevenueStatisticsService,
  RevenueValidationService,
} from './services';

@Global()
@Module({
  imports: [PlatformConfigurationModule, TreasuryModule, WalletModule],
  controllers: [RevenueController],
  providers: [
    RevenueConfigurationService,
    RevenueCalculationService,
    HostEarningsService,
    RevenueValidationService,
    RevenueDistributionService,
    RevenueHistoryService,
    RevenueAuditService,
    RevenueStatisticsService,
    RevenueQueryService,
    RevenueEventService,
  ],
  exports: [
    RevenueConfigurationService,
    RevenueCalculationService,
    HostEarningsService,
    RevenueValidationService,
    RevenueDistributionService,
    RevenueHistoryService,
    RevenueAuditService,
    RevenueStatisticsService,
    RevenueQueryService,
    RevenueEventService,
  ],
})
export class RevenueModule {}
