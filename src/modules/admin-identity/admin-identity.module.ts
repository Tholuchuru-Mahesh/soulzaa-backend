import { Module } from '@nestjs/common';
import { AuthInfraModule } from 'src/infra/auth/auth-infra.module';
import { ModeratorShiftModule } from 'src/modules/moderator-shift/moderator-shift.module';
import { AdminProvisioningAdminController } from './controllers/admin-provisioning-admin.controller';
import { ModeratorProvisioningAdminController } from './controllers/moderator-provisioning-admin.controller';
import { ADMIN_IDENTITY_SERVICE } from './interfaces/admin-identity.interface';
import { AdminRoleSyncListener } from './listeners/admin-role-sync.listener';
import { AdminCredentialRepository } from './repositories/admin-credential.repository';
import { Admin2faService } from './services/admin-2fa.service';
import { AdminIdentityService } from './services/admin-identity.service';
import { AdminProvisioningService } from './services/admin-provisioning.service';
import { ModeratorProvisioningService } from './services/moderator-provisioning.service';

/**
 * Admin identity — the hidden-staff-account rule, and (from Task 8) Admin
 * provisioning. Orchestrates the users and authorization modules through their
 * public contracts; owns no business engine of its own.
 */
@Module({
  imports: [AuthInfraModule, ModeratorShiftModule],
  controllers: [AdminProvisioningAdminController, ModeratorProvisioningAdminController],
  providers: [
    AdminIdentityService,
    { provide: ADMIN_IDENTITY_SERVICE, useExisting: AdminIdentityService },
    AdminRoleSyncListener,
    AdminProvisioningService,
    ModeratorProvisioningService,
    AdminCredentialRepository,
    Admin2faService,
  ],
  exports: [ADMIN_IDENTITY_SERVICE, Admin2faService],
})
export class AdminIdentityModule {}
