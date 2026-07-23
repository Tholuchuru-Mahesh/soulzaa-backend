import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { WithdrawalController } from './controllers/withdrawal.controller';
import {
  WithdrawalApprovalService,
  WithdrawalAuditService,
  WithdrawalConfigurationService,
  WithdrawalEventService,
  WithdrawalExecutionService,
  WithdrawalHistoryService,
  WithdrawalQueryService,
  WithdrawalService,
  WithdrawalStatisticsService,
  WithdrawalValidationService,
} from './services';

@Global()
@Module({
  imports: [PlatformConfigurationModule, TreasuryModule, WalletModule],
  controllers: [WithdrawalController],
  providers: [
    WithdrawalConfigurationService,
    WithdrawalValidationService,
    WithdrawalService,
    WithdrawalApprovalService,
    WithdrawalExecutionService,
    WithdrawalHistoryService,
    WithdrawalAuditService,
    WithdrawalStatisticsService,
    WithdrawalQueryService,
    WithdrawalEventService,
  ],
  exports: [
    WithdrawalConfigurationService,
    WithdrawalValidationService,
    WithdrawalService,
    WithdrawalApprovalService,
    WithdrawalExecutionService,
    WithdrawalHistoryService,
    WithdrawalAuditService,
    WithdrawalStatisticsService,
    WithdrawalQueryService,
    WithdrawalEventService,
  ],
})
export class WithdrawalsModule {}
