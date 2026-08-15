import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { AgencyDashboardController } from './controllers/agency-dashboard.controller';
import { AgencyAuditLogController } from './controllers/agency-audit-log.controller';
import { AgencyActivationController } from './controllers/agency-activation.controller';
import { AgencyDirectoryController } from './controllers/agency-directory.controller';
import {
  AgencyJoinController,
  AgencyJoinReviewController,
} from './controllers/agency-join-request.controller';
import { AgencyMemberController } from './controllers/agency-member.controller';
import { AgencyOperationsController } from './controllers/agency-operations.controller';
import { AgencySettlementController } from './controllers/agency-settlement.controller';
import { AgencyAuditLogService } from './services/agency-audit-log.service';
import { AgencyActivationService } from './services/agency-activation.service';
import { AgencyDirectoryService } from './services/agency-directory.service';
import { AgencyJoinRequestService } from './services/agency-join-request.service';
import { AgencyMemberService } from './services/agency-member.service';
import { AgencyRewardService } from './services/agency-reward.service';
import { AgencyTaskService } from './services/agency-task.service';
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
  controllers: [
    AgencySettlementController,
    AgencyDashboardController,
    AgencyMemberController,
    AgencyAuditLogController,
    AgencyOperationsController,
    AgencyActivationController,
    AgencyDirectoryController,
    AgencyJoinController,
    AgencyJoinReviewController,
  ],
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
    AgencyMemberService,
    AgencyAuditLogService,
    AgencyTaskService,
    AgencyRewardService,
    AgencyActivationService,
    AgencyDirectoryService,
    AgencyJoinRequestService,
  ],
  exports: [
    AgencyActivationService,
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
