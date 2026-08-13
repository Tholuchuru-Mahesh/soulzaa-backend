import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ScopeType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationCacheService } from 'src/modules/authorization/services/authorization-cache.service';
import { PolicyEngineService } from 'src/modules/authorization/services/policy-engine.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { RoleService } from 'src/modules/authorization/services/role.service';
import { CountryService } from 'src/modules/organization/services/country.service';
import { RegionService } from 'src/modules/organization/services/region.service';
import { StateService } from 'src/modules/organization/services/state.service';
import {
  AssignUserRoleDto,
  PromoteDemoteUserDto,
  UpdateUserRoleDto,
} from '../dto/role-assignment.dto';

@Injectable()
export class RoleAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roleService: RoleService,
    private readonly countryService: CountryService,
    private readonly stateService: StateService,
    private readonly regionService: RegionService,
    private readonly authCacheService: AuthorizationCacheService,
    private readonly roleResolver: RoleResolver,
    private readonly policyEngine: PolicyEngineService,
  ) {}

  /**
   * Resolves whether the acting user holds SUPER_ADMIN, reading the RBAC store
   * rather than trusting a caller-supplied role list. A token claim goes stale
   * the moment a role is revoked, so escalation checks must not depend on it.
   */
  private async actorIsSuperAdmin(actorId: string): Promise<boolean> {
    return this.roleResolver.hasRole(actorId, 'SUPER_ADMIN');
  }

  /**
   * Rank gate for role changes, applied twice per operation:
   *
   *  - against the *role being granted or revoked*, so an actor cannot hand out
   *    authority at or above their own — the named ADMIN/COUNTRY_MANAGER checks
   *    never covered SUPER_ADMIN itself, which left it grantable by any ADMIN;
   *  - against the *account being modified*, so an ADMIN cannot rewrite the roles
   *    of a SUPER_ADMIN or of a peer.
   */
  private async assertMayChangeRole(actorId: string, targetUserId: string, roleName: string) {
    const [actorRoles, targetUserRoles] = await Promise.all([
      this.roleResolver.getRoleNames(actorId),
      this.roleResolver.getRoleNames(targetUserId),
    ]);

    const decisions = await Promise.all([
      this.policyEngine.evaluate({
        actorUserId: actorId,
        actorRoles,
        action: 'user.role.grant',
        targetUserId,
        targetRoles: [roleName],
      }),
      this.policyEngine.evaluate({
        actorUserId: actorId,
        actorRoles,
        action: 'user.role.assign',
        targetUserId,
        targetRoles: targetUserRoles,
      }),
    ]);

    if (decisions.some((allowed) => !allowed)) {
      throw new ForbiddenException(
        `Insufficient authority to change the '${roleName}' role on this account`,
      );
    }
  }

  /**
   * Assigns a role to a user with strict validation rules.
   */
  async assignRole(userId: string, dto: AssignUserRoleDto, actorId: string) {
    // 1. Verify User Exists
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found`);
    }

    // 2. Resolve Target Role
    const roleNameUpper = dto.role.trim().toUpperCase();
    const role = await this.prisma.role.findFirst({
      where: {
        OR: [{ id: dto.role }, { name: roleNameUpper }],
      },
    });
    if (!role) {
      throw new NotFoundException(`Role '${dto.role}' not found`);
    }

    // 3. Validation Rule: Only SUPER_ADMIN can assign ADMIN or COUNTRY_MANAGER
    if (role.name === 'ADMIN' || role.name === 'COUNTRY_MANAGER') {
      if (!(await this.actorIsSuperAdmin(actorId))) {
        throw new ForbiddenException(`Only SUPER_ADMIN can assign '${role.name}' role`);
      }
    }

    // 3b. Rank gate — covers every other role, including SUPER_ADMIN itself.
    await this.assertMayChangeRole(actorId, userId, role.name);

    // 4. Validation Rule: Check Duplicate Active Role Assignment
    const existingUserRole = await this.prisma.userRole.findUnique({
      where: {
        userId_roleId: { userId, roleId: role.id },
      },
    });
    if (existingUserRole) {
      throw new ConflictException(
        `User '${user.username}' already has the '${role.name}' role assigned`,
      );
    }

    // 5. Validation Rule: Geographic Scope Entity Verification & Single Country Manager Limit
    if (dto.scopeType === ScopeType.COUNTRY && dto.countryId) {
      const country = await this.countryService.getCountryById(dto.countryId);
      if (!country.isActive) {
        throw new BadRequestException(`Cannot assign scope to inactive country '${country.name}'`);
      }

      if (role.name === 'COUNTRY_MANAGER') {
        // Scoped to the Country Manager role itself — other roles (BD, Official)
        // legitimately hold country scopes and must not read as an incumbent.
        const existingCM = await this.prisma.roleScope.findFirst({
          where: {
            scopeType: ScopeType.COUNTRY,
            countryId: dto.countryId,
            userRole: { roleId: role.id },
          },
          include: {
            userRole: true,
          },
        });
        if (existingCM && existingCM.userRole.userId !== userId) {
          throw new ConflictException(
            `Country '${country.name}' already has an active Country Manager`,
          );
        }
      }
    } else if (dto.scopeType === ScopeType.STATE && dto.stateId) {
      const state = await this.stateService.getStateById(dto.stateId);
      if (!state.isActive) {
        throw new BadRequestException(`Cannot assign scope to inactive state '${state.name}'`);
      }
    } else if (dto.scopeType === ScopeType.REGION && dto.regionId) {
      const region = await this.regionService.getRegionById(dto.regionId);
      if (!region.isActive) {
        throw new BadRequestException(`Cannot assign scope to inactive region '${region.name}'`);
      }
    }

    // 6. Assign Role via RoleService
    const assignedUserRole = await this.roleService.assignRoleToUser(
      { userId, roleId: role.id },
      actorId,
    );

    // 7. Assign Geographic Scope if requested
    if (dto.scopeType) {
      await this.roleService.assignRoleScope({
        userRoleId: assignedUserRole.id,
        scopeType: dto.scopeType,
        countryId: dto.countryId,
        stateId: dto.stateId,
        regionId: dto.regionId,
      });
    }

    // 8. Invalidate Redis Authorization Cache
    await this.authCacheService.invalidateUser(userId);

    return {
      message: `Role '${role.name}' assigned to user '${user.username}' successfully`,
      userId: user.id,
      roleId: role.id,
      roleName: role.name,
      scopeType: dto.scopeType ?? ScopeType.GLOBAL,
    };
  }

  /**
   * Removes a role assignment and its associated scopes from a user.
   */
  async removeRole(userId: string, roleIdOrName: string, actorId: string) {
    const roleNameUpper = roleIdOrName.trim().toUpperCase();
    const role = await this.prisma.role.findFirst({
      where: {
        OR: [{ id: roleIdOrName }, { name: roleNameUpper }],
      },
    });
    if (!role) {
      throw new NotFoundException(`Role '${roleIdOrName}' not found`);
    }

    if (role.name === 'ADMIN' || role.name === 'COUNTRY_MANAGER') {
      if (!(await this.actorIsSuperAdmin(actorId))) {
        throw new ForbiddenException(`Only SUPER_ADMIN can remove '${role.name}' role`);
      }
    }

    await this.assertMayChangeRole(actorId, userId, role.name);

    const userRole = await this.prisma.userRole.findUnique({
      where: {
        userId_roleId: { userId, roleId: role.id },
      },
    });
    if (!userRole) {
      throw new NotFoundException(`User does not have role '${role.name}' assigned`);
    }

    // Remove role and cascade scopes via RoleService
    await this.roleService.removeRoleFromUser(userId, role.id);

    // Invalidate Redis Authorization Cache
    await this.authCacheService.invalidateUser(userId);

    return {
      message: `Role '${role.name}' removed from user successfully`,
      userId,
      roleId: role.id,
      roleName: role.name,
    };
  }

  /**
   * Replaces a user's role assignment with a new role assignment.
   */
  async updateRole(userId: string, dto: UpdateUserRoleDto, actorId: string) {
    await this.removeRole(userId, dto.currentRole, actorId);
    return this.assignRole(
      userId,
      {
        role: dto.newRole,
        scopeType: dto.scopeType,
        countryId: dto.countryId,
        stateId: dto.stateId,
        regionId: dto.regionId,
      },
      actorId,
    );
  }

  /**
   * Promotes a user to a higher platform role.
   */
  async promoteUser(userId: string, dto: PromoteDemoteUserDto, actorId: string) {
    return this.assignRole(
      userId,
      {
        role: dto.targetRole,
        scopeType: dto.scopeType,
        countryId: dto.countryId,
        stateId: dto.stateId,
        regionId: dto.regionId,
      },
      actorId,
    );
  }

  /**
   * Demotes a user by assigning target role.
   */
  async demoteUser(userId: string, dto: PromoteDemoteUserDto, actorId: string) {
    return this.assignRole(
      userId,
      {
        role: dto.targetRole,
        scopeType: dto.scopeType,
        countryId: dto.countryId,
        stateId: dto.stateId,
        regionId: dto.regionId,
      },
      actorId,
    );
  }

  /**
   * Revokes the Creator status (removes Creator role, deletes/resets UserVerification so they can apply from scratch).
   */
  // `_actorId` is accepted but unused: callers pass the acting admin to match
  // every other method on this service, and it is what an audit entry here
  // would need. Renamed rather than dropped so the signature stays uniform.
  async revokeCreator(targetUserId: string, _actorId: string): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID '${targetUserId}' not found`);
    }

    const role = await this.prisma.role.findUnique({
      where: { name: 'CREATOR' },
    });

    if (role) {
      await this.prisma.userRole.deleteMany({
        where: {
          userId: targetUserId,
          roleId: role.id,
        },
      });
    }

    const currentRoles = user.roles || [];
    const updatedRoles = currentRoles.filter((r) => r !== ('CREATOR' as any));
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        roles: {
          set: updatedRoles,
        },
      },
    });

    await this.prisma.userVerification.updateMany({
      where: { userId: targetUserId },
      data: {
        verified: false,
        status: 'NONE',
        type: null,
        documentKey: null,
        rejectionReason: null,
        reviewedAt: null,
        reviewedBy: null,
      },
    });

    await this.authCacheService.invalidateUser(targetUserId);

    return {
      message: `Creator status successfully revoked for user '${user.username}'`,
      userId: targetUserId,
    };
  }
}
