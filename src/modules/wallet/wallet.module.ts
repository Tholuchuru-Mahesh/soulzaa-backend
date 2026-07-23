import { Global, Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { WalletAdminController } from './controllers/wallet-admin.controller';
import { WalletController } from './controllers/wallet.controller';
import { WALLET_SERVICE } from './interfaces/wallet.service.interface';
import { WalletRepository } from './repositories/wallet.repository';
import { BalanceService } from './services/balance.service';
import { LedgerService } from './services/ledger.service';
import { ReservationService } from './services/reservation.service';
import { TransactionQueryService } from './services/transaction-query.service';
import { WalletAuditService } from './services/wallet-audit.service';
import { WalletTransactionService } from './services/wallet-transaction.service';
import { WalletValidationService } from './services/wallet-validation.service';
import { WalletService } from './services/wallet.service';
import { WalletReadService } from './services/wallet-read.service';
import { WalletReconciliationService } from './services/wallet-reconciliation.service';
import { WalletReconciliationScheduler } from './schedulers/wallet-reconciliation.scheduler';
import { WalletMetrics } from './metrics/wallet.metrics';
import { WalletRealtimeListener } from './listeners/wallet-realtime.listener';

@Global()
@Module({
  imports: [PrismaModule, PlatformConfigurationModule, TreasuryModule],
  controllers: [WalletController, WalletAdminController],
  providers: [
    WalletRepository,
    WalletService,
    WalletReadService,
    WalletReconciliationService,
    WalletReconciliationScheduler,
    WalletMetrics,
    WalletRealtimeListener,
    { provide: WALLET_SERVICE, useExisting: WalletService },
    WalletAuditService,
    WalletValidationService,
    LedgerService,
    BalanceService,
    ReservationService,
    WalletTransactionService,
    TransactionQueryService,
  ],
  exports: [
    WALLET_SERVICE,
    WalletRepository,
    WalletService,
    WalletAuditService,
    WalletValidationService,
    LedgerService,
    BalanceService,
    ReservationService,
    WalletTransactionService,
    TransactionQueryService,
    WalletReadService,
    WalletMetrics,
    WalletReconciliationService,
  ],
})
export class WalletModule {}
