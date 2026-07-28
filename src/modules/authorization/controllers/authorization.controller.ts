import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
} from '../decorators/authorization.decorators';
import { AssignPermissionDto } from '../dto/assign-permission.dto';
import { AssignRoleDto } from '../dto/assign-role.dto';
import { AuditLogQueryDto } from '../dto/audit-log-query.dto';
import { CreatePermissionDto } from '../dto/create-permission.dto';
import { CreateRoleDto } from '../dto/create-role.dto';
import { CreateRoleScopeDto } from '../dto/create-scope.dto';
import { CreateRoleHierarchyDto } from '../dto/role-hierarchy.dto';
import { RbacPermissionsGuard } from '../guards/rbac-permissions.guard';
import { AuditLogInterceptor } from '../interceptors/audit-log.interceptor';
import { AuditLogService } from '../services/audit-log.service';
import { AuthorizationService } from '../services/authorization.service';
import { PermissionService } from '../services/permission.service';
import { RoleService } from '../services/role.service';

@ApiTags('Authorization')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@UseInterceptors(AuditLogInterceptor)
@Controller('authorization')
export class AuthorizationController {
  constructor(
    private readonly authorizationService: AuthorizationService,
    private readonly roleService: RoleService,
    private readonly permissionService: PermissionService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ---------------------------------------------------------
  // Effective Authorization Profile for Authenticated User
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Get current user effective authorization profile' })
  @ApiResponse({
    status: 200,
    description:
      'Detailed user identity, assigned roles, inherited roles, resolved permissions, categories, and scopes',
  })
  @Get('me')
  async getEffectivePermissionsForMe(@CurrentUser('id') userId: string) {
    return this.authorizationService.getEffectivePermissions(userId);
  }

  // ---------------------------------------------------------
  // Roles Management APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Get all platform roles' })
  @ApiResponse({ status: 200, description: 'List of all platform roles' })
  @Get('roles')
  async getAllRoles() {
    return this.roleService.getAllRoles();
  }

  @ApiOperation({ summary: 'Create a new role' })
  @ApiResponse({ status: 201, description: 'Role created successfully' })
  @RequirePermissions('role.manage')
  @AuditLogAction('role.create', 'role')
  @Post('roles')
  async createRole(@Body() dto: CreateRoleDto) {
    return this.roleService.createRole(dto);
  }

  @ApiOperation({ summary: 'Assign a role to a user' })
  @ApiResponse({ status: 200, description: 'Role assigned successfully' })
  @RequirePermissions('role.assign')
  @AuditLogAction('role.assign', 'user')
  @Post('roles/assign')
  @HttpCode(HttpStatus.OK)
  async assignRole(@Body() dto: AssignRoleDto, @CurrentUser('id') actorId: string) {
    return this.roleService.assignRoleToUser(dto, actorId);
  }

  @ApiOperation({ summary: 'Remove a role from a user' })
  @ApiResponse({ status: 200, description: 'Role removed successfully' })
  @RequirePermissions('role.assign')
  @AuditLogAction('role.remove', 'user')
  @Delete('roles/users/:userId/roles/:roleId')
  async removeRole(@Param('userId') userId: string, @Param('roleId') roleId: string) {
    return this.roleService.removeRoleFromUser(userId, roleId);
  }

  // ---------------------------------------------------------
  // Permissions Management APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Get all granular permissions' })
  @ApiQuery({ name: 'category', required: false, description: 'Filter permissions by category' })
  @ApiResponse({ status: 200, description: 'List of all system permissions' })
  @Get('permissions')
  async getAllPermissions(@Query('category') category?: string) {
    return this.permissionService.getAllPermissions(category);
  }

  @ApiOperation({ summary: 'Create a new granular permission' })
  @ApiResponse({ status: 201, description: 'Permission created successfully' })
  @RequirePermissions('permission.manage')
  @AuditLogAction('permission.create', 'permission')
  @Post('permissions')
  async createPermission(@Body() dto: CreatePermissionDto) {
    return this.permissionService.createPermission(dto);
  }

  @ApiOperation({ summary: 'Assign a permission to a role' })
  @ApiResponse({ status: 200, description: 'Permission mapped to role successfully' })
  @RequirePermissions('permission.manage')
  @AuditLogAction('permission.assign', 'role')
  @Post('permissions/assign')
  @HttpCode(HttpStatus.OK)
  async assignPermission(@Body() dto: AssignPermissionDto) {
    return this.permissionService.assignPermissionToRole(dto);
  }

  // ---------------------------------------------------------
  // Role Hierarchy APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Get data-driven role hierarchy graph' })
  @ApiResponse({ status: 200, description: 'List of parent-child role hierarchy edges' })
  @Get('hierarchy')
  async getRoleHierarchy() {
    return this.roleService.getRoleHierarchy();
  }

  @ApiOperation({ summary: 'Add a role hierarchy parent-child relationship' })
  @ApiResponse({ status: 201, description: 'Role hierarchy edge created successfully' })
  @RequirePermissions('role.hierarchy.manage')
  @AuditLogAction('hierarchy.create', 'role_hierarchy')
  @Post('hierarchy')
  async addRoleHierarchyEdge(@Body() dto: CreateRoleHierarchyDto) {
    return this.roleService.addRoleHierarchyEdge(dto);
  }

  // ---------------------------------------------------------
  // Geographic Scope Infrastructure APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Assign geographic operational scope to a user role' })
  @ApiResponse({ status: 201, description: 'Geographic scope assigned successfully' })
  @RequirePermissions('scope.manage')
  @AuditLogAction('scope.assign', 'role_scope')
  @Post('scopes')
  async assignRoleScope(@Body() dto: CreateRoleScopeDto) {
    return this.roleService.assignRoleScope(dto);
  }

  @ApiOperation({ summary: 'Get resolved geographic scopes for a user' })
  @ApiResponse({ status: 200, description: 'List of assigned geographic scopes for user' })
  @RequirePermissions('user.view')
  @Get('users/:userId/scopes')
  async getUserScopes(@Param('userId') userId: string) {
    return this.authorizationService.getUserScopes(userId);
  }

  // ---------------------------------------------------------
  // User Authorization Introspection APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Get resolved permissions for a user' })
  @ApiResponse({ status: 200, description: 'List of active permission codes for target user' })
  @RequirePermissions('user.view')
  @Get('users/:userId/permissions')
  async getUserPermissions(@Param('userId') userId: string) {
    const permissions = await this.authorizationService.getUserPermissions(userId);
    return { userId, permissions };
  }

  @ApiOperation({ summary: 'Get resolved roles for a user' })
  @ApiResponse({ status: 200, description: 'List of direct and inherited roles for target user' })
  @RequirePermissions('user.view')
  @Get('users/:userId/roles')
  async getUserRoles(@Param('userId') userId: string) {
    const roles = await this.authorizationService.getUserRoles(userId);
    return { userId, roles };
  }

  // ---------------------------------------------------------
  // Audit Logs APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Query audit logs' })
  @ApiResponse({ status: 200, description: 'Paginated list of audit log records' })
  @RequirePermissions('audit.view')
  @Get('audit-logs')
  async getAuditLogs(@Query() query: AuditLogQueryDto) {
    return this.auditLogService.getAuditLogs(query);
  }
}
