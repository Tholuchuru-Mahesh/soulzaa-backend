import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { RedisModule } from 'src/infra/redis/redis.module';
import { AuthorizationModule } from 'src/modules/authorization/authorization.module';
import { GiftsModule } from 'src/modules/gifts/gifts.module';
import { OrganizationModule } from 'src/modules/organization/organization.module';
import { PaymentsModule } from 'src/modules/payments/payments.module';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { SuperAdminAgencyProfileController } from './controllers/super-admin-agency-profile.controller';
import { SuperAdminConfigurationController } from './controllers/super-admin-configuration.controller';
import { SuperAdminGiftController } from './controllers/super-admin-gift.controller';
import { SuperAdminOrganizationController } from './controllers/super-admin-organization.controller';
import { SuperAdminPurchaseController } from './controllers/super-admin-purchase.controller';
import { SuperAdminTreasuryController } from './controllers/super-admin-treasury.controller';
import { SuperAdminUserController } from './controllers/super-admin-user.controller';
import { SuperAdminWalletController } from './controllers/super-admin-wallet.controller';
import { SuperAdminWorkforceController } from './controllers/super-admin-workforce.controller';
import { AccountLifecycleService } from './services/account-lifecycle.service';
import { AgencyProfileService } from './services/agency-profile.service';
import { CountryManagerAssignmentService } from './services/country-manager-assignment.service';
import { OperationalStatusService } from './services/operational-status.service';
import { ReportingHierarchyService } from './services/reporting-hierarchy.service';
import { RoleAssignmentService } from './services/role-assignment.service';
import { UserManagementService } from './services/user-management.service';
import { UserQueryService } from './services/user-query.service';
import { WorkforceAssignmentService } from './services/workforce-assignment.service';
import { WorkforceManagementService } from './services/workforce-management.service';
import { WorkforceQueryService } from './services/workforce-query.service';
import { WorkloadService } from './services/workload.service';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    AuthorizationModule,
    OrganizationModule,
    PlatformConfigurationModule,
    TreasuryModule,
    WalletModule,
    PaymentsModule,
    GiftsModule,
  ],
  controllers: [
    SuperAdminOrganizationController,
    SuperAdminUserController,
    SuperAdminWorkforceController,
    SuperAdminConfigurationController,
    SuperAdminTreasuryController,
    SuperAdminWalletController,
    SuperAdminPurchaseController,
    SuperAdminGiftController,
    SuperAdminAgencyProfileController,
  ],
  providers: [
    CountryManagerAssignmentService,
    UserQueryService,
    RoleAssignmentService,
    AccountLifecycleService,
    UserManagementService,
    WorkforceQueryService,
    WorkforceAssignmentService,
    ReportingHierarchyService,
    WorkloadService,
    OperationalStatusService,
    WorkforceManagementService,
    AgencyProfileService,
  ],
  exports: [
    CountryManagerAssignmentService,
    UserQueryService,
    RoleAssignmentService,
    AccountLifecycleService,
    UserManagementService,
    WorkforceQueryService,
    WorkforceAssignmentService,
    ReportingHierarchyService,
    WorkloadService,
    OperationalStatusService,
    WorkforceManagementService,
    AgencyProfileService,
  ],
})
export class SuperAdminModule {}
