import { ROLE_SOURCE, type IRoleSource } from 'src/common/interfaces/role-source.interface';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import {
  AuditLogAction,
  CurrentUser,
  RequirePermissions,
  RequireRoles,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import { LockAccountDto, SuspendAccountDto } from '../dto/account-status.dto';
import {
  AssignUserRoleDto,
  PromoteDemoteUserDto,
  UpdateUserRoleDto,
} from '../dto/role-assignment.dto';
import { UserSearchFilterDto } from '../dto/user-query.dto';
import { UserManagementService } from '../services/user-management.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@ApiTags('Super Admin - User & Role Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@UseInterceptors(AuditLogInterceptor)
@Controller('super-admin/users')
export class SuperAdminUserController {
  constructor(
    private readonly userManagementService: UserManagementService,
    private readonly prisma: PrismaService,
    @Inject(ROLE_SOURCE) private readonly roleSource: IRoleSource,
  ) {}

  // ---------------------------------------------------------
  // User Search & Listing APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Search and filter platform users with pagination & sorting' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of matching users with assigned roles and scopes',
  })
  @RequirePermissions('user.list.view')
  @Get()
  async searchUsers(@Query() filterDto: UserSearchFilterDto, @CurrentUser('id') viewerId: string) {
    return this.userManagementService.searchUsers(
      filterDto,
      await this.viewerIsSuperAdmin(viewerId),
    );
  }

  @ApiOperation({ summary: 'Super Admin: list all pending creator verification requests' })
  @ApiResponse({ status: 200, description: 'List of pending creator requests' })
  @RequirePermissions('user.role.assign')
  @Get('verifications/pending')
  async getPendingVerifications() {
    return this.userManagementService.getPendingVerifications();
  }

  @ApiOperation({ summary: 'Super Admin: list members linked to a specific agency' })
  @ApiResponse({ status: 200, description: 'List of agency members' })
  @RequirePermissions('user.list.view')
  @Get('agencies/:agencyId/members')
  async getAgencyMembers(@Param('agencyId') agencyId: string) {
    return this.userManagementService.getAgencyMembers(agencyId);
  }

  @ApiOperation({
    summary:
      'Get complete user profile details (roles, inherited permissions, scopes, recent activity)',
  })
  @ApiResponse({ status: 200, description: 'Detailed user profile and RBAC state' })
  @RequirePermissions('user.profile.view')
  @Get(':id')
  async getUserProfileDetails(@Param('id') id: string, @CurrentUser('id') viewerId: string) {
    return this.userManagementService.getUserProfileDetails(
      id,
      await this.viewerIsSuperAdmin(viewerId),
    );
  }

  /**
   * Only a Super Admin may identify another Super Admin (spec §1). Resolved from
   * the RBAC store rather than the JWT claim, so a token minted before a
   * demotion cannot still unmask.
   */
  private async viewerIsSuperAdmin(viewerId: string): Promise<boolean> {
    const names = await this.roleSource.getRoleNames(viewerId);
    return names.includes('SUPER_ADMIN');
  }

  @ApiOperation({ summary: 'Get audit logs history for a specific user' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'User audit history logs' })
  @RequirePermissions('user.audit.view')
  @Get(':id/audit-logs')
  async getUserAuditHistory(
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.userManagementService.getUserAuditHistory(
      id,
      page ? Number(page) : 1,
      limit ? Number(limit) : 20,
    );
  }

  // ---------------------------------------------------------
  // Role Management APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Assign a platform role and optional geographic scope to a user' })
  @ApiResponse({ status: 200, description: 'Role assigned successfully' })
  @RequirePermissions('user.role.assign')
  @AuditLogAction('USER_ROLE_ASSIGNED', 'user_role')
  @Post(':id/roles')
  @HttpCode(HttpStatus.OK)
  async assignRole(
    @Param('id') userId: string,
    @Body() dto: AssignUserRoleDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.userManagementService.assignRole(userId, dto, actorId);
  }

  @ApiOperation({ summary: 'Remove a platform role from a user' })
  @ApiResponse({ status: 200, description: 'Role removed successfully' })
  @RequirePermissions('user.role.remove')
  @AuditLogAction('USER_ROLE_REMOVED', 'user_role')
  @Delete(':id/roles/:roleId')
  async removeRole(
    @Param('id') userId: string,
    @Param('roleId') roleId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.userManagementService.removeRole(userId, roleId, actorId);
  }

  @ApiOperation({ summary: 'Replace an existing role assignment with a new role' })
  @ApiResponse({ status: 200, description: 'User role updated successfully' })
  @RequirePermissions('user.role.update')
  @AuditLogAction('USER_ROLE_UPDATED', 'user_role')
  @Put(':id/roles')
  async updateRole(
    @Param('id') userId: string,
    @Body() dto: UpdateUserRoleDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.userManagementService.updateRole(userId, dto, actorId);
  }

  @ApiOperation({ summary: 'Promote user to a higher administrative role' })
  @ApiResponse({ status: 200, description: 'User promoted successfully' })
  @RequirePermissions('user.role.assign')
  @AuditLogAction('USER_PROMOTED', 'user_role')
  @Post(':id/promote')
  @HttpCode(HttpStatus.OK)
  async promoteUser(
    @Param('id') userId: string,
    @Body() dto: PromoteDemoteUserDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.userManagementService.promoteUser(userId, dto, actorId);
  }

  @ApiOperation({ summary: 'Demote user to a lower administrative role' })
  @ApiResponse({ status: 200, description: 'User demoted successfully' })
  @RequirePermissions('user.role.assign')
  @AuditLogAction('USER_DEMOTED', 'user_role')
  @Post(':id/demote')
  @HttpCode(HttpStatus.OK)
  async demoteUser(
    @Param('id') userId: string,
    @Body() dto: PromoteDemoteUserDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.userManagementService.demoteUser(userId, dto, actorId);
  }

  // ---------------------------------------------------------
  // Account Lifecycle APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Activate a user account' })
  @ApiResponse({ status: 200, description: 'Account activated' })
  @RequirePermissions('user.status.activate')
  @AuditLogAction('ACCOUNT_ACTIVATED', 'user_account')
  @Patch(':id/status/activate')
  async activateAccount(@Param('id') userId: string, @CurrentUser('id') actorId: string) {
    return this.userManagementService.activateAccount(userId, actorId);
  }

  @ApiOperation({ summary: 'Suspend a user account' })
  @ApiResponse({ status: 200, description: 'Account suspended' })
  @RequirePermissions('user.status.suspend')
  @AuditLogAction('ACCOUNT_SUSPENDED', 'user_account')
  @Patch(':id/status/suspend')
  async suspendAccount(
    @Param('id') userId: string,
    @Body() dto: SuspendAccountDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.userManagementService.suspendAccount(userId, dto, actorId);
  }

  @ApiOperation({ summary: 'Reactivate a suspended user account' })
  @ApiResponse({ status: 200, description: 'Account reactivated' })
  @RequirePermissions('user.status.activate')
  @AuditLogAction('ACCOUNT_REACTIVATED', 'user_account')
  @Patch(':id/status/reactivate')
  async reactivateAccount(@Param('id') userId: string, @CurrentUser('id') actorId: string) {
    return this.userManagementService.reactivateAccount(userId, actorId);
  }

  @ApiOperation({ summary: 'Lock a user account' })
  @ApiResponse({ status: 200, description: 'Account locked' })
  @RequirePermissions('user.status.lock')
  @AuditLogAction('ACCOUNT_LOCKED', 'user_account')
  @Patch(':id/status/lock')
  async lockAccount(
    @Param('id') userId: string,
    @Body() dto: LockAccountDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.userManagementService.lockAccount(userId, dto, actorId);
  }

  @ApiOperation({ summary: 'Unlock a locked user account' })
  @ApiResponse({ status: 200, description: 'Account unlocked' })
  @RequirePermissions('user.status.unlock')
  @AuditLogAction('ACCOUNT_UNLOCKED', 'user_account')
  @Patch(':id/status/unlock')
  async unlockAccount(@Param('id') userId: string, @CurrentUser('id') actorId: string) {
    return this.userManagementService.unlockAccount(userId, actorId);
  }

  @ApiOperation({ summary: 'Force logout active user sessions' })
  @ApiResponse({ status: 200, description: 'User active sessions invalidated' })
  @RequirePermissions('user.session.force_logout')
  @AuditLogAction('FORCE_LOGOUT', 'user_session')
  @Post(':id/force-logout')
  @HttpCode(HttpStatus.OK)
  async forceLogout(@Param('id') userId: string, @CurrentUser('id') actorId: string) {
    return this.userManagementService.forceLogout(userId, actorId);
  }

  @ApiOperation({ summary: 'Super Admin: revoke/remove creator verification and role' })
  @ApiResponse({ status: 200, description: 'Creator status revoked' })
  @RequirePermissions('user.role.assign')
  @AuditLogAction('CREATOR_REVOKED', 'user_account')
  @Delete(':id/creator')
  async revokeCreator(@Param('id') userId: string, @CurrentUser('id') actorId: string) {
    return this.userManagementService.revokeCreator(userId, actorId);
  }

  @ApiOperation({
    summary: 'Get user security details (login history, trusted devices, active sessions)',
  })
  @ApiResponse({ status: 200, description: 'User security details' })
  @RequirePermissions('user.profile.view')
  @Get(':id/security')
  async getUserSecurityDetails(@Param('id') id: string) {
    const [loginHistory, initialDevices, activeSessions] = await Promise.all([
      this.prisma.sessionHistory.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.userDevice.findMany({
        where: { userId: id, deletedAt: null },
        orderBy: { lastActiveAt: 'desc' },
      }),
      this.prisma.userSession.findMany({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastActivityAt: 'desc' },
      }),
    ]);

    const trustedDevices = initialDevices;

    const formattedLoginHistory = loginHistory.map((lh: any) => {
      const isFailed = lh.event === 'FAILED_LOGIN';
      let loginType = 'Email & password';

      const meta = lh.metadata as any;
      if (isFailed) {
        loginType = 'Failed login';
      } else if (meta?.provider) {
        if (meta.provider === 'GOOGLE') loginType = 'Google Login';
        else if (meta.provider === 'APPLE') loginType = 'Apple Login';
        else if (meta.provider === 'MOBILE_OTP') loginType = 'OTP Login';
      } else if (meta?.method) {
        if (meta.method === 'google') loginType = 'Google Login';
        else if (meta.method === 'apple') loginType = 'Apple Login';
        else if (meta.method === 'otp' || meta.method === 'mobile') loginType = 'OTP Login';
      }

      return {
        id: lh.id,
        createdAt: lh.createdAt,
        loginType,
        ipAddress: lh.ip || '—',
        location: lh.country ? `${lh.country}` : 'Unknown',
        device: lh.deviceType ? `${lh.deviceType} (${lh.os || 'Unknown'})` : lh.userAgent || '—',
        status: isFailed ? 'Failed' : 'Success',
      };
    });

    const formattedTrustedDevices = trustedDevices.map((d: any) => ({
      id: d.id,
      device: d.deviceName || d.deviceType || 'Unknown Device',
      firstTrustedOn: d.trustedAt || d.createdAt,
      lastUsed: d.lastActiveAt || d.updatedAt,
      status: d.trusted ? 'Trusted' : 'Untrusted',
    }));

    const deviceIds = activeSessions.map((s: any) => s.deviceId).filter(Boolean) as string[];
    const devices =
      deviceIds.length > 0
        ? await this.prisma.userDevice.findMany({
            where: { id: { in: deviceIds } },
          })
        : [];
    const deviceMap = new Map<string, any>(devices.map((d: any) => [d.id, d]));

    const formattedActiveSessions = activeSessions.map((s: any) => {
      const dev = s.deviceId ? deviceMap.get(s.deviceId) : null;
      return {
        id: s.id,
        device: dev?.deviceName || dev?.deviceType || s.userAgent || 'Unknown Device',
        ipAddress: s.createdByIp || dev?.ipAddress || '—',
        location: dev?.country || 'Unknown',
      };
    });

    return {
      loginHistory: formattedLoginHistory,
      trustedDevices: formattedTrustedDevices,
      activeSessions: formattedActiveSessions,
    };
  }

  @ApiOperation({ summary: 'Revoke/terminate a specific active user session' })
  @ApiResponse({ status: 200, description: 'Session terminated' })
  @RequirePermissions('user.session.force_logout')
  @AuditLogAction('SESSION_REVOKED', 'user_session')
  @Delete(':id/sessions/:sessionId')
  async terminateSession(@Param('id') userId: string, @Param('sessionId') sessionId: string) {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, userId },
      data: { revokedAt: new Date() },
    });
    // Record audit event in SessionHistory
    await this.prisma.sessionHistory.create({
      data: {
        userId,
        sessionId,
        event: 'REVOKED',
        metadata: { revokedBy: 'SUPER_ADMIN' },
      },
    });
    return { success: true };
  }

  @ApiOperation({ summary: 'Remove/untrust a trusted device' })
  @ApiResponse({ status: 200, description: 'Device untrusted' })
  @RequirePermissions('user.status.lock')
  @Delete(':id/devices/:deviceId')
  async untrustDevice(@Param('id') userId: string, @Param('deviceId') deviceId: string) {
    await this.prisma.userDevice.updateMany({
      where: { id: deviceId, userId },
      data: { trusted: false, trustedAt: null, deletedAt: new Date() },
    });
    await this.prisma.trustedDevice.deleteMany({
      where: { deviceId, userId },
    });
    return { success: true };
  }

  @ApiOperation({ summary: 'Trust a user device' })
  @ApiResponse({ status: 200, description: 'Device trusted' })
  @RequirePermissions('user.status.lock')
  @Put(':id/devices/:deviceId/trust')
  async trustDevice(@Param('id') userId: string, @Param('deviceId') deviceId: string) {
    await this.prisma.userDevice.updateMany({
      where: { id: deviceId, userId },
      data: { trusted: true, trustedAt: new Date() },
    });
    const existing = await this.prisma.trustedDevice.findFirst({
      where: { deviceId, userId },
    });
    if (!existing) {
      await this.prisma.trustedDevice.create({
        data: {
          userId,
          deviceId,
          trustedAt: new Date(),
        },
      });
    }
    return { success: true };
  }
}
