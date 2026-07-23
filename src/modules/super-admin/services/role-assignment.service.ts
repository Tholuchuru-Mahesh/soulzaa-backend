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
  ) {}

  /**
   * Assigns a role to a user with strict validation rules.
   */
  async assignRole(userId: string, dto: AssignUserRoleDto, actorId: string, actorRoles: string[]) {
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
    const isSuperAdminActor = actorRoles.includes('SUPER_ADMIN');
    if ((role.name === 'ADMIN' || role.name === 'COUNTRY_MANAGER') && !isSuperAdminActor) {
      throw new ForbiddenException(`Only SUPER_ADMIN can assign '${role.name}' role`);
    }

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
        const existingCM = await this.prisma.roleScope.findFirst({
          where: {
            scopeType: ScopeType.COUNTRY,
            countryId: dto.countryId,
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
  async removeRole(userId: string, roleIdOrName: string, actorId: string, actorRoles: string[]) {
    const roleNameUpper = roleIdOrName.trim().toUpperCase();
    const role = await this.prisma.role.findFirst({
      where: {
        OR: [{ id: roleIdOrName }, { name: roleNameUpper }],
      },
    });
    if (!role) {
      throw new NotFoundException(`Role '${roleIdOrName}' not found`);
    }

    const isSuperAdminActor = actorRoles.includes('SUPER_ADMIN');
    if ((role.name === 'ADMIN' || role.name === 'COUNTRY_MANAGER') && !isSuperAdminActor) {
      throw new ForbiddenException(`Only SUPER_ADMIN can remove '${role.name}' role`);
    }

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
  async updateRole(userId: string, dto: UpdateUserRoleDto, actorId: string, actorRoles: string[]) {
    await this.removeRole(userId, dto.currentRole, actorId, actorRoles);
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
      actorRoles,
    );
  }

  /**
   * Promotes a user to a higher platform role.
   */
  async promoteUser(
    userId: string,
    dto: PromoteDemoteUserDto,
    actorId: string,
    actorRoles: string[],
  ) {
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
      actorRoles,
    );
  }

  /**
   * Demotes a user by assigning target role.
   */
  async demoteUser(
    userId: string,
    dto: PromoteDemoteUserDto,
    actorId: string,
    actorRoles: string[],
  ) {
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
      actorRoles,
    );
  }
}
