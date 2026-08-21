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
   * Resolves full Country/State IDs from a Region ID.
   * Used when the Super Admin selects a Region during OFFICIAL assignment so
   * that the User record always carries country + state columns even though
   * the authoritative RoleScope is STATE-level.
   */
  private async resolveRegionHierarchy(
    regionId: string,
  ): Promise<{ stateId: string | null; countryId: string | null }> {
    const region = await this.prisma.region.findUnique({
      where: { id: regionId },
      select: { stateId: true, state: { select: { countryId: true } } },
    });
    return {
      stateId: region?.stateId ?? null,
      countryId: region?.state?.countryId ?? null,
    };
  }

  /**
   * Assigns operational personnel role and geographic scope.
   *
   * OFFICIAL rule: scopeType is always forced to STATE regardless of what the
   * DTO says. Country + State are required; Region is accepted as UI context
   * (stored on the User record) but does NOT further restrict data access.
   */
  async assignWorkforce(dto: AssignWorkforceDto, actorId: string) {
    const roleUpper = dto.role.trim().toUpperCase();
    if (!WORKFORCE_ROLES.includes(roleUpper as any)) {
      throw new BadRequestException(`Role '${dto.role}' is not a valid operational workforce role`);
    }

    // ── OFFICIAL enforcement: scopeType must always be STATE ────────────────
    // The Official's data access boundary is their assigned State. The Super
    // Admin form collects Country + State + (optionally) Region for display
    // purposes, but the RoleScope row that drives all queries is STATE-level.
    let effectiveScopeType = dto.scopeType;
    const effectiveCountryId = dto.countryId;
    const effectiveStateId = dto.stateId;
    const effectiveRegionId = dto.regionId; // stored on User only

    if (roleUpper === 'OFFICIAL') {
      // Force STATE scope regardless of what the frontend sent.
      effectiveScopeType = 'STATE';

      if (!effectiveStateId) {
        throw new BadRequestException(
          `Assigning an Official requires a State. Please select Country → State.`,
        );
      }
      if (!effectiveCountryId) {
        throw new BadRequestException(
          `Assigning an Official requires a Country. Please select Country → State.`,
        );
      }

      // If a Region was provided, validate it belongs to the selected State.
      if (effectiveRegionId) {
        const region = await this.prisma.region.findUnique({
          where: { id: effectiveRegionId },
          select: { stateId: true, state: { select: { countryId: true } } },
        });
        if (!region) {
          throw new BadRequestException(`Region with ID '${effectiveRegionId}' not found.`);
        }
        if (region.stateId !== effectiveStateId) {
          throw new BadRequestException(
            `The selected Region does not belong to the selected State. Please recheck the hierarchy.`,
          );
        }
        if (effectiveCountryId && region.state?.countryId !== effectiveCountryId) {
          throw new BadRequestException(
            `The selected Region's State does not belong to the selected Country.`,
          );
        }
      }

      // Hierarchy validation: ensure state belongs to the given country.
      const state = await this.prisma.state.findUnique({
        where: { id: effectiveStateId },
        select: { countryId: true },
      });
      if (!state) {
        throw new BadRequestException(`State with ID '${effectiveStateId}' not found.`);
      }
      if (state.countryId !== effectiveCountryId) {
        throw new BadRequestException(
          `The selected State does not belong to the selected Country. Please recheck the hierarchy.`,
        );
      }
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

    // 3. Validate Scope Entity (uses effective* values after OFFICIAL enforcement above)
    if (effectiveScopeType === ScopeType.COUNTRY && effectiveCountryId) {
      const country = await this.countryService.getCountryById(effectiveCountryId);
      if (!country.isActive) {
        throw new BadRequestException(
          `Cannot assign workforce to inactive country '${country.name}'`,
        );
      }

      if (roleUpper === 'COUNTRY_MANAGER') {
        const existingCM = await this.prisma.roleScope.findFirst({
          where: {
            scopeType: ScopeType.COUNTRY,
            countryId: effectiveCountryId,
          },
          include: { userRole: true },
        });
        if (existingCM && existingCM.userRole.userId !== dto.userId) {
          throw new ConflictException(
            `Country '${country.name}' already has an assigned active Country Manager`,
          );
        }
      }
    } else if (effectiveScopeType === ScopeType.STATE && effectiveStateId) {
      const state = await this.stateService.getStateById(effectiveStateId);
      if (!state.isActive) {
        throw new BadRequestException(`Cannot assign workforce to inactive state '${state.name}'`);
      }
    }

    // 4. Assign UserRole
    const userRole = await this.roleService.assignRoleToUser(
      { userId: dto.userId, roleId: role.id },
      actorId,
    );

    // 5. Assign RoleScope
    // For OFFICIAL the scope is STATE-level — countryId/stateId are set,
    // regionId is intentionally omitted from the RoleScope row so the
    // WorkforceScopeService matches on stateId (sees all regions in the state).
    await this.roleService.assignRoleScope({
      userRoleId: userRole.id,
      scopeType: effectiveScopeType,
      countryId: effectiveCountryId,
      stateId: effectiveStateId,
      // Only pass regionId for non-OFFICIAL scopes; OFFICIAL uses STATE scope.
      regionId: roleUpper === 'OFFICIAL' ? undefined : effectiveRegionId,
    });

    // 6. Synchronize user record's location columns
    // For OFFICIAL we always store country + state + region (if provided)
    // on the User row for UI display purposes, even though the RoleScope
    // only uses countryId + stateId for authorization.
    await this.prisma.user.update({
      where: { id: dto.userId },
      data: {
        countryId: effectiveCountryId ?? null,
        stateId: effectiveStateId ?? null,
        regionId: effectiveRegionId ?? null,
      },
    });

    // 7. Invalidate Auth Cache
    await this.authCacheService.invalidateUser(dto.userId);

    return {
      message: `Workforce personnel '${user.username}' assigned as '${role.name}' successfully`,
      userId: user.id,
      roleName: role.name,
      scopeType: effectiveScopeType,
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
