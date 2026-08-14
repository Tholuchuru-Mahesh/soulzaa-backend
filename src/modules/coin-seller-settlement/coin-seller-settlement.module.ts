import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { CoinSellerSettlementController } from './controllers/coin-seller-settlement.controller';
import { CoinSellerInventoryController } from './controllers/coin-seller-inventory.controller';
import { CoinSellerOfficialController } from './controllers/coin-seller-official.controller';
import { MobileWorkforceModule } from 'src/modules/mobile-workforce/mobile-workforce.module';
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
  CoinSellerInventoryService,
  CoinSellerUserSaleService,
} from './services';

@Global()
@Module({
  imports: [PlatformConfigurationModule, TreasuryModule, WalletModule, MobileWorkforceModule],
  controllers: [CoinSellerSettlementController, CoinSellerInventoryController, CoinSellerOfficialController],
  providers: [
    CoinSellerConfigurationService,
    CoinSellerCommissionService,
    CoinSellerRelationshipService,
    CoinSellerValidationService,
    CoinSellerInventoryService,
    CoinSellerUserSaleService,
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
    CoinSellerInventoryService,
    CoinSellerUserSaleService,
    CoinSellerSettlementService,
    CoinSellerHistoryService,
    CoinSellerAuditService,
    CoinSellerStatisticsService,
    CoinSellerQueryService,
    CoinSellerEventService,
  ],
})
export class CoinSellerSettlementModule {}
