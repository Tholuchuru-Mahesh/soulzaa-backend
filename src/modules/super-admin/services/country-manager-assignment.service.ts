import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ScopeType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RoleService } from 'src/modules/authorization/services/role.service';

@Injectable()
export class CountryManagerAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roleService: RoleService,
  ) {}

  /**
   * Assigns a user as a Country Manager for a target country.
   */
  async assignCountryManager(countryId: string, userId: string, actorId?: string) {
    const country = await this.prisma.country.findUnique({ where: { id: countryId } });
    if (!country) {
      throw new NotFoundException(`Country with ID '${countryId}' not found`);
    }

    if (!country.isActive) {
      throw new BadRequestException(
        `Cannot assign Country Manager to inactive country '${country.name}'`,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found`);
    }

    const cmRole = await this.prisma.role.findUnique({ where: { name: 'COUNTRY_MANAGER' } });
    if (!cmRole) {
      throw new NotFoundException(`System role 'COUNTRY_MANAGER' not found in database`);
    }

    // 1. Assign COUNTRY_MANAGER role via RoleService
    const userRole = await this.roleService.assignRoleToUser(
      { userId, roleId: cmRole.id },
      actorId,
    );

    // 2. Assign Scope for countryId if not already present
    const existingScope = await this.prisma.roleScope.findFirst({
      where: {
        userRoleId: userRole.id,
        scopeType: ScopeType.COUNTRY,
        countryId,
      },
    });

    if (!existingScope) {
      await this.roleService.assignRoleScope({
        userRoleId: userRole.id,
        scopeType: ScopeType.COUNTRY,
        countryId,
      });
    }

    return {
      message: `User '${user.username}' assigned as Country Manager for '${country.name}'`,
      userId: user.id,
      countryId: country.id,
      countryName: country.name,
    };
  }

  /**
   * Transfers a Country Manager from one country to a target country.
   */
  async transferCountryManager(
    currentCountryId: string,
    userId: string,
    targetCountryId: string,
    actorId?: string,
  ) {
    const targetCountry = await this.prisma.country.findUnique({ where: { id: targetCountryId } });
    if (!targetCountry) {
      throw new NotFoundException(`Target Country with ID '${targetCountryId}' not found`);
    }

    if (!targetCountry.isActive) {
      throw new BadRequestException(
        `Cannot transfer Country Manager to inactive country '${targetCountry.name}'`,
      );
    }

    // 1. Remove current country scope
    await this.removeCountryManager(currentCountryId, userId);

    // 2. Assign to target country
    return this.assignCountryManager(targetCountryId, userId, actorId);
  }

  /**
   * Removes Country Manager assignment and geographic scope from a country.
   */
  async removeCountryManager(countryId: string, userId: string) {
    const cmRole = await this.prisma.role.findUnique({ where: { name: 'COUNTRY_MANAGER' } });
    if (!cmRole) {
      throw new NotFoundException(`System role 'COUNTRY_MANAGER' not found`);
    }

    const userRole = await this.prisma.userRole.findUnique({
      where: {
        userId_roleId: { userId, roleId: cmRole.id },
      },
    });

    if (userRole) {
      // Remove country scope
      await this.prisma.roleScope.deleteMany({
        where: {
          userRoleId: userRole.id,
          scopeType: ScopeType.COUNTRY,
          countryId,
        },
      });

      // Check if user has any remaining scopes under this role
      const remainingScopes = await this.prisma.roleScope.count({
        where: { userRoleId: userRole.id },
      });

      // If no scopes remain, remove COUNTRY_MANAGER role assignment
      if (remainingScopes === 0) {
        await this.roleService.removeRoleFromUser(userId, cmRole.id);
      }
    }

    return {
      message: `Country Manager assignment removed for user '${userId}' from country '${countryId}'`,
      userId,
      countryId,
    };
  }
}
