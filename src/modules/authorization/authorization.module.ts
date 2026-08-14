import { Global, Module } from '@nestjs/common';
import { ROLE_SOURCE } from '../../common/interfaces/role-source.interface';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { RedisModule } from '../../infra/redis/redis.module';
import { AuthorizationController } from './controllers/authorization.controller';
import { RbacPermissionsGuard } from './guards/rbac-permissions.guard';
import { RbacRolesGuard } from './guards/rbac-roles.guard';
import { AuditLogInterceptor } from './interceptors/audit-log.interceptor';
import { AuditLogService } from './services/audit-log.service';
import { AuthorizationCacheService } from './services/authorization-cache.service';
import { AuthorizationService } from './services/authorization.service';
import { GeographicScopeResolver } from './services/geographic-scope-resolver.service';
import { PermissionResolver } from './services/permission-resolver.service';
import { PermissionService } from './services/permission.service';
import { PolicyEngineService, RoleRankPolicyRule } from './services/policy-engine.service';
import { RbacSeederService } from './services/rbac-seeder.service';
import {
  ResourceOwnershipService,
  UserProfileOwnershipProvider,
} from './services/resource-ownership.service';
import { RoleResolver } from './services/role-resolver.service';
import { RoleService } from './services/role.service';

@Global()
@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [AuthorizationController],
  providers: [
    AuthorizationService,
    AuthorizationCacheService,
    PermissionResolver,
    RoleResolver,
    GeographicScopeResolver,
    PermissionService,
    RoleService,
    AuditLogService,
    ResourceOwnershipService,
    UserProfileOwnershipProvider,
    PolicyEngineService,
    RoleRankPolicyRule,
    RbacSeederService,
    RbacPermissionsGuard,
    RbacRolesGuard,
    AuditLogInterceptor,
    // Supplies the common-layer RolesGuard with RBAC-resolved roles, so
    // @Roles(...) and @RequirePermissions(...) read the same store.
    { provide: ROLE_SOURCE, useExisting: RoleResolver },
  ],
  exports: [
    AuthorizationService,
    AuthorizationCacheService,
    PermissionResolver,
    RoleResolver,
    GeographicScopeResolver,
    PermissionService,
    RoleService,
    AuditLogService,
    ResourceOwnershipService,
    UserProfileOwnershipProvider,
    PolicyEngineService,
    RoleRankPolicyRule,
    RbacPermissionsGuard,
    RbacRolesGuard,
    ROLE_SOURCE,
  ],
})
export class AuthorizationModule {}
