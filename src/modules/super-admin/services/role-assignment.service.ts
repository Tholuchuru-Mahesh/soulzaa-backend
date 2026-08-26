import { randomInt } from 'node:crypto';
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
  AssignUserRoleByEmailDto,
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
   * Assigns a role to the user identified by their registered e-mail address.
   * Looks up the user first. If no user exists with this email yet, auto-provisions
   * a user account so Super Admin can assign the role to the email first.
   * Then delegates to the standard `assignRole` so all existing validation rules
   * (rank gates, scope checks, etc.) remain in effect.
   */
  async assignRoleByEmail(dto: AssignUserRoleByEmailDto, actorId: string) {
    const cleanEmail = dto.email.trim().toLowerCase();
    let user = await this.prisma.user.findFirst({
      where: { email: { equals: cleanEmail, mode: 'insensitive' } },
      select: { id: true },
    });

    if (!user) {
      // Auto-provision user account for this email if they haven't registered yet
      const emailPrefix = cleanEmail
        .split('@')[0]
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .toLowerCase();
      let uniqueUsername = emailPrefix;
      let counter = 1;
      while (await this.prisma.user.findFirst({ where: { username: uniqueUsername } })) {
        uniqueUsername = `${emailPrefix}_${Math.floor(1000 + Math.random() * 9000)}`;
        counter++;
        if (counter > 10) {
          uniqueUsername = `${emailPrefix}_${Date.now()}`;
          break;
        }
      }

      const roleUpper = dto.role.trim().toUpperCase();
      const isStaff = ['ADMIN', 'SUPER_ADMIN', 'OFFICIAL', 'COUNTRY_MANAGER', 'MODERATOR'].includes(
        roleUpper,
      );

      let displayId = randomInt(10000000, 100000000);
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await this.prisma.user.findUnique({ where: { displayId } });
        if (!existing) break;
        displayId = randomInt(10000000, 100000000);
      }

      const newUser = await this.prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            displayId,
            username: uniqueUsername,
            email: cleanEmail,
            fullName: emailPrefix,
            status: 'ACTIVE',
            isGuest: false,
            createdBy: actorId,
            isHiddenAccount: isStaff,
            roles: ['USER'],
          },
        });

        await tx.userProfile.create({
          data: {
            userId: createdUser.id,
          },
        });
        await tx.userStatistics.create({ data: { userId: createdUser.id } });
        await tx.userVerification.create({ data: { userId: createdUser.id } });

        return createdUser;
      });

      user = { id: newUser.id };
    }

    return this.assignRole(
      user.id,
      {
        role: dto.role,
        scopeType: dto.scopeType,
        countryId: dto.countryId,
        stateId: dto.stateId,
        regionId: dto.regionId,
      },
      actorId,
    );
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
    const trimmedRole = dto.role.trim();
    const roleNameUpper = trimmedRole.toUpperCase();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trimmedRole,
    );
    const role = await this.prisma.role.findFirst({
      where: isUuid
        ? { OR: [{ id: trimmedRole }, { name: roleNameUpper }] }
        : { name: roleNameUpper },
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

    // 4b. Validation Rule: One assignable role per account.
    await this.assertRoleIsExclusive(userId, user.username, role.name);

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

    // 7b. Synchronize User.roles column so UserIdentity projections reflect the role
    const currentRoles = user.roles || [];
    if (!currentRoles.includes(role.name as any)) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          roles: {
            set: [...currentRoles, role.name as any],
          },
        },
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
   * Roles nobody appoints: USER comes with the account, HOST and CREATOR are
   * earned through the product. None of them is an assignment, so none of them
   * may block one.
   */
  private static readonly AUTOMATIC_ROLES: ReadonlySet<string> = new Set([
    'USER',
    'HOST',
    'CREATOR',
  ]);

  /**
   * The one pair an operator may build. Coin Seller is activated *inside* an
   * existing Agency account rather than replacing it, so the two coexist.
   */
  private static readonly COMBINABLE_ROLES: ReadonlySet<string> = new Set([
    'AGENCY',
    'COIN_SELLER',
  ]);

  /**
   * An account holds one assignable role. Stacking a second one silently leaves
   * the holder with the union of both permission sets — which is how an Agency
   * ended up carrying Official authority.
   *
   * Reads the granted rows rather than the resolver: the hierarchy would report
   * every inherited role and refuse every assignment.
   */
  private async assertRoleIsExclusive(
    userId: string,
    username: string,
    roleName: string,
  ): Promise<void> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId, suspendedAt: null },
      include: { role: { select: { name: true } } },
    });

    const held = rows
      .map((r) => r.role.name)
      .filter((name) => !RoleAssignmentService.AUTOMATIC_ROLES.has(name));
    if (held.length === 0) return;

    const combined = [...new Set([...held, roleName])];
    if (combined.every((name) => RoleAssignmentService.COMBINABLE_ROLES.has(name))) return;

    throw new ConflictException(
      `User '${username}' already holds ${held.join(', ')}. An account may hold only one role — remove it before assigning ${roleName}.`,
    );
  }

  /**
   * Removes a role assignment and its associated scopes from a user.
   */
  async removeRole(userId: string, roleIdOrName: string, actorId: string) {
    const trimmedRole = roleIdOrName.trim();
    const roleNameUpper = trimmedRole.toUpperCase();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trimmedRole,
    );
    const role = await this.prisma.role.findFirst({
      where: isUuid
        ? { OR: [{ id: trimmedRole }, { name: roleNameUpper }] }
        : { name: roleNameUpper },
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

    // Sync User.roles column
    const existingUser = await this.prisma.user.findUnique({ where: { id: userId } });
    if (existingUser) {
      const updatedRoles = (existingUser.roles || []).filter((r) => r !== (role.name as any));
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          roles: {
            set: updatedRoles,
          },
        },
      });
    }

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
