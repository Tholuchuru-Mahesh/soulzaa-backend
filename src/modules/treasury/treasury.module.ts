import { Global, Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { CoinEconomyService } from './services/coin-economy.service';
import { FinancialHealthService } from './services/financial-health.service';
import { FinancialPolicyService } from './services/financial-policy.service';
import { RiskManagementService } from './services/risk-management.service';
import { TreasuryAuditService } from './services/treasury-audit.service';
import { TreasurySeederService } from './services/treasury-seeder.service';
import { TreasuryService } from './services/treasury.service';

@Global()
@Module({
  imports: [PrismaModule, PlatformConfigurationModule],
  providers: [
    TreasuryAuditService,
    TreasuryService,
    CoinEconomyService,
    FinancialPolicyService,
    FinancialHealthService,
    RiskManagementService,
    TreasurySeederService,
  ],
  exports: [
    TreasuryAuditService,
    TreasuryService,
    CoinEconomyService,
    FinancialPolicyService,
    FinancialHealthService,
    RiskManagementService,
    TreasurySeederService,
  ],
})
export class TreasuryModule {}
