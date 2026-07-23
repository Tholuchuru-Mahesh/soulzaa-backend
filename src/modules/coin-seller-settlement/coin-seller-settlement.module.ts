import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { CoinSellerSettlementController } from './controllers/coin-seller-settlement.controller';
import {
  CoinSellerAuditService,
  CoinSellerCommissionService,
  CoinSellerConfigurationService,
  CoinSellerEventService,
  CoinSellerHistoryService,
  CoinSellerQueryService,
  CoinSellerRelationshipService,
  CoinSellerSettlementService,
  CoinSellerStatisticsService,
  CoinSellerValidationService,
} from './services';

@Global()
@Module({
  imports: [PlatformConfigurationModule, TreasuryModule, WalletModule],
  controllers: [CoinSellerSettlementController],
  providers: [
    CoinSellerConfigurationService,
    CoinSellerCommissionService,
    CoinSellerRelationshipService,
    CoinSellerValidationService,
    CoinSellerSettlementService,
    CoinSellerHistoryService,
    CoinSellerAuditService,
    CoinSellerStatisticsService,
    CoinSellerQueryService,
    CoinSellerEventService,
  ],
  exports: [
    CoinSellerConfigurationService,
    CoinSellerCommissionService,
    CoinSellerRelationshipService,
    CoinSellerValidationService,
    CoinSellerSettlementService,
    CoinSellerHistoryService,
    CoinSellerAuditService,
    CoinSellerStatisticsService,
    CoinSellerQueryService,
    CoinSellerEventService,
  ],
})
export class CoinSellerSettlementModule {}
