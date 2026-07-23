import { Global, Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { BalanceService } from './services/balance.service';
import { LedgerService } from './services/ledger.service';
import { ReservationService } from './services/reservation.service';
import { TransactionQueryService } from './services/transaction-query.service';
import { WalletAuditService } from './services/wallet-audit.service';
import { WalletTransactionService } from './services/wallet-transaction.service';
import { WalletValidationService } from './services/wallet-validation.service';
import { WalletService } from './services/wallet.service';

@Global()
@Module({
  imports: [PrismaModule, PlatformConfigurationModule, TreasuryModule],
  providers: [
    WalletAuditService,
    WalletValidationService,
    WalletService,
    LedgerService,
    BalanceService,
    ReservationService,
    WalletTransactionService,
    TransactionQueryService,
  ],
  exports: [
    WalletAuditService,
    WalletValidationService,
    WalletService,
    LedgerService,
    BalanceService,
    ReservationService,
    WalletTransactionService,
    TransactionQueryService,
  ],
})
export class WalletModule {}
