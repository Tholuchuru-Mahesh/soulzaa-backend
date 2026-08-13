import { Module } from '@nestjs/common';
import { AdminProvisioningAdminController } from './controllers/admin-provisioning-admin.controller';
import { ADMIN_IDENTITY_SERVICE } from './interfaces/admin-identity.interface';
import { AdminRoleSyncListener } from './listeners/admin-role-sync.listener';
import { AdminCredentialRepository } from './repositories/admin-credential.repository';
import { Admin2faService } from './services/admin-2fa.service';
import { AdminIdentityService } from './services/admin-identity.service';
import { AdminProvisioningService } from './services/admin-provisioning.service';

/**
 * Admin identity — the hidden-staff-account rule, and (from Task 8) Admin
 * provisioning. Orchestrates the users and authorization modules through their
 * public contracts; owns no business engine of its own.
 *
 * No `imports` needed: UsersModule (USERS_SERVICE, PROFILE_SERVICE) and
 * AuthorizationModule (ROLE_SOURCE) are both @Global, so their tokens resolve
 * without a module-to-module import that the boundary rule would reject.
 */
@Module({
  controllers: [AdminProvisioningAdminController],
  providers: [
    AdminIdentityService,
    { provide: ADMIN_IDENTITY_SERVICE, useExisting: AdminIdentityService },
    AdminRoleSyncListener,
    AdminProvisioningService,
    AdminCredentialRepository,
    Admin2faService,
  ],
  exports: [ADMIN_IDENTITY_SERVICE, Admin2faService],
})
export class AdminIdentityModule {}
