import { Global, Module } from '@nestjs/common';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { WealthAdminController } from './controllers/wealth-admin.controller';
import { WealthController } from './controllers/wealth.controller';
import { WEALTH_SERVICE } from './interfaces/wealth.service.interface';
import { WealthExpReversalListener } from './listeners/wealth-exp-reversal.listener';
import { WealthExpListener } from './listeners/wealth-exp.listener';
import { WealthRepository } from './repositories/wealth.repository';
import { WealthAdminService } from './services/wealth-admin.service';
import { WealthBenefitService } from './services/wealth-benefit.service';
import { WealthDowngradeConfigService } from './services/wealth-downgrade-config.service';
import { WealthExpLedgerService } from './services/wealth-exp-ledger.service';
import { WealthLevelService } from './services/wealth-level.service';
import { WealthMonthlyResetScheduler } from './services/wealth-monthly-reset.scheduler';
import { WealthMonthlyResetService } from './services/wealth-monthly-reset.service';
import { WealthProgressService } from './services/wealth-progress.service';

/**
 * The Wealth Level system — the sole VIP progression system. EXP flows in
 * only from the verified Gold Coin purchase flow (`WealthExpListener`,
 * subscribing to `WALLET_EVENTS.CREDITED`); everything else (levels,
 * benefits, monthly reset, downgrade, admin) lives here. Benefit claims are
 * fulfilled through `RewardFulfillmentEngine` (`TasksModule`, `@Global()`),
 * so no explicit import of that module is needed here.
 */
@Global()
@Module({
  imports: [WalletModule],
  controllers: [WealthController, WealthAdminController],
  providers: [
    WealthRepository,
    WealthLevelService,
    WealthProgressService,
    WealthBenefitService,
    WealthExpLedgerService,
    WealthDowngradeConfigService,
    WealthMonthlyResetService,
    WealthMonthlyResetScheduler,
    WealthAdminService,
    WealthExpListener,
    WealthExpReversalListener,
    { provide: WEALTH_SERVICE, useExisting: WealthProgressService },
  ],
  exports: [
    WEALTH_SERVICE,
    WealthLevelService,
    WealthProgressService,
    WealthBenefitService,
    WealthExpLedgerService,
    WealthDowngradeConfigService,
    WealthMonthlyResetService,
    WealthAdminService,
  ],
})
export class WealthModule {}
