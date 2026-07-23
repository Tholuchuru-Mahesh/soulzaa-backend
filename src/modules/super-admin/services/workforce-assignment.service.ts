import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus, ScopeType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationCacheService } from 'src/modules/authorization/services/authorization-cache.service';
import { RoleService } from 'src/modules/authorization/services/role.service';
import { CountryService } from 'src/modules/organization/services/country.service';
import { RegionService } from 'src/modules/organization/services/region.service';
import { StateService } from 'src/modules/organization/services/state.service';
import {
  AssignWorkforceDto,
  ReassignWorkforceScopeDto,
  TransferWorkforceDto,
} from '../dto/workforce-assignment.dto';
import { WORKFORCE_ROLES } from './workforce-query.service';

@Injectable()
export class WorkforceAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roleService: RoleService,
    private readonly countryService: CountryService,
    private readonly stateService: StateService,
    private readonly regionService: RegionService,
    private readonly authCacheService: AuthorizationCacheService,
  ) {}

  /**
   * Assigns operational personnel role and geographic scope
   */
  async assignWorkforce(dto: AssignWorkforceDto, actorId: string) {
    const roleUpper = dto.role.trim().toUpperCase();
    if (!WORKFORCE_ROLES.includes(roleUpper as any)) {
      throw new BadRequestException(`Role '${dto.role}' is not a valid operational workforce role`);
    }

    // 1. Verify User Exists and is Active
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!user) {
      throw new NotFoundException(`User with ID '${dto.userId}' not found`);
    }
    if (user.status !== AccountStatus.ACTIVE) {
      throw new BadRequestException(
        `Cannot assign workforce scope to non-active user account '${user.username}' (Status: ${user.status})`,
      );
    }

    // 2. Resolve Role
    const role = await this.prisma.role.findUnique({ where: { name: roleUpper } });
    if (!role) {
      throw new NotFoundException(`Role '${roleUpper}' not found`);
    }

    // 3. Validate Scope Entity
    if (dto.scopeType === ScopeType.COUNTRY && dto.countryId) {
      const country = await this.countryService.getCountryById(dto.countryId);
      if (!country.isActive) {
        throw new BadRequestException(
          `Cannot assign workforce to inactive country '${country.name}'`,
        );
      }

      if (roleUpper === 'COUNTRY_MANAGER') {
        const existingCM = await this.prisma.roleScope.findFirst({
          where: {
            scopeType: ScopeType.COUNTRY,
            countryId: dto.countryId,
          },
          include: { userRole: true },
        });
        if (existingCM && existingCM.userRole.userId !== dto.userId) {
          throw new ConflictException(
            `Country '${country.name}' already has an assigned active Country Manager`,
          );
        }
      }
    } else if (dto.scopeType === ScopeType.STATE && dto.stateId) {
      const state = await this.stateService.getStateById(dto.stateId);
      if (!state.isActive) {
        throw new BadRequestException(`Cannot assign workforce to inactive state '${state.name}'`);
      }
    } else if (dto.scopeType === ScopeType.REGION && dto.regionId) {
      const region = await this.regionService.getRegionById(dto.regionId);
      if (!region.isActive) {
        throw new BadRequestException(
          `Cannot assign workforce to inactive region '${region.name}'`,
        );
      }
    }

    // 4. Assign UserRole
    const userRole = await this.roleService.assignRoleToUser(
      { userId: dto.userId, roleId: role.id },
      actorId,
    );

    // 5. Assign RoleScope
    await this.roleService.assignRoleScope({
      userRoleId: userRole.id,
      scopeType: dto.scopeType,
      countryId: dto.countryId,
      stateId: dto.stateId,
      regionId: dto.regionId,
    });

    // 6. Invalidate Auth Cache
    await this.authCacheService.invalidateUser(dto.userId);

    return {
      message: `Workforce personnel '${user.username}' assigned as '${role.name}' successfully`,
      userId: user.id,
      roleName: role.name,
      scopeType: dto.scopeType,
    };
  }

  /**
   * Transfers operational personnel to a new geographic scope
   */
  async transferWorkforce(dto: TransferWorkforceDto, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!user) {
      throw new NotFoundException(`Personnel with ID '${dto.userId}' not found`);
    }

    // Find active workforce user role
    const userRole = await this.prisma.userRole.findFirst({
      where: {
        userId: dto.userId,
        role: { name: { in: WORKFORCE_ROLES as any } },
      },
      include: { role: true },
    });

    if (!userRole) {
      throw new NotFoundException(
        `Personnel '${user.username}' has no active workforce role assignment to transfer`,
      );
    }

    // Delete existing scopes under this role
    await this.prisma.roleScope.deleteMany({
      where: { userRoleId: userRole.id },
    });

    // Assign new scope
    return this.assignWorkforce(
      {
        userId: dto.userId,
        role: userRole.role.name,
        scopeType: dto.targetScopeType,
        countryId: dto.targetCountryId,
        stateId: dto.targetStateId,
        regionId: dto.targetRegionId,
      },
      actorId,
    );
  }

  /**
   * Reassigns personnel scope
   */
  async reassignScope(dto: ReassignWorkforceScopeDto, actorId: string) {
    return this.transferWorkforce(
      {
        userId: dto.userId,
        targetScopeType: dto.scopeType,
        targetCountryId: dto.countryId,
        targetStateId: dto.stateId,
        targetRegionId: dto.regionId,
      },
      actorId,
    );
  }
}
