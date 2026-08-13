import { Injectable } from '@nestjs/common';
import { LockAccountDto, SuspendAccountDto } from '../dto/account-status.dto';
import {
  AssignUserRoleDto,
  PromoteDemoteUserDto,
  UpdateUserRoleDto,
} from '../dto/role-assignment.dto';
import { UserSearchFilterDto } from '../dto/user-query.dto';
import { AccountLifecycleService } from './account-lifecycle.service';
import { RoleAssignmentService } from './role-assignment.service';
import { UserQueryService } from './user-query.service';

@Injectable()
export class UserManagementService {
  constructor(
    private readonly queryService: UserQueryService,
    private readonly roleAssignmentService: RoleAssignmentService,
    private readonly lifecycleService: AccountLifecycleService,
  ) {}

  // ---------------------------------------------------------
  // User Queries & Inspection
  // ---------------------------------------------------------
  async searchUsers(dto: UserSearchFilterDto, viewerIsSuperAdmin = false) {
    return this.queryService.searchUsers(dto, viewerIsSuperAdmin);
  }

  async getUserProfileDetails(userId: string, viewerIsSuperAdmin = false) {
    return this.queryService.getUserProfileDetails(userId, viewerIsSuperAdmin);
  }

  async getUserAuditHistory(userId: string, page = 1, limit = 20) {
    return this.queryService.getUserAuditHistory(userId, page, limit);
  }

  // ---------------------------------------------------------
  // Role Assignment Operations
  // ---------------------------------------------------------
  async assignRole(userId: string, dto: AssignUserRoleDto, actorId: string) {
    return this.roleAssignmentService.assignRole(userId, dto, actorId);
  }

  async removeRole(userId: string, roleIdOrName: string, actorId: string) {
    return this.roleAssignmentService.removeRole(userId, roleIdOrName, actorId);
  }

  async updateRole(userId: string, dto: UpdateUserRoleDto, actorId: string) {
    return this.roleAssignmentService.updateRole(userId, dto, actorId);
  }

  async promoteUser(userId: string, dto: PromoteDemoteUserDto, actorId: string) {
    return this.roleAssignmentService.promoteUser(userId, dto, actorId);
  }

  async demoteUser(userId: string, dto: PromoteDemoteUserDto, actorId: string) {
    return this.roleAssignmentService.demoteUser(userId, dto, actorId);
  }

  // ---------------------------------------------------------
  // Account Lifecycle Operations
  // ---------------------------------------------------------
  async activateAccount(userId: string, actorId: string) {
    return this.lifecycleService.activateAccount(userId, actorId);
  }

  async suspendAccount(userId: string, dto: SuspendAccountDto, actorId: string) {
    return this.lifecycleService.suspendAccount(userId, dto, actorId);
  }

  async reactivateAccount(userId: string, actorId: string) {
    return this.lifecycleService.reactivateAccount(userId, actorId);
  }

  async lockAccount(userId: string, dto: LockAccountDto, actorId: string) {
    return this.lifecycleService.lockAccount(userId, dto, actorId);
  }

  async unlockAccount(userId: string, actorId: string) {
    return this.lifecycleService.unlockAccount(userId, actorId);
  }
  async forceLogout(userId: string, actorId: string) {
    return this.lifecycleService.forceLogout(userId, actorId);
  }

  async getPendingVerifications() {
    return this.queryService.getPendingVerifications();
  }

  async revokeCreator(userId: string, actorId: string) {
    return this.roleAssignmentService.revokeCreator(userId, actorId);
  }
}
