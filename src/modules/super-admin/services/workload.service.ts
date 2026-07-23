import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface PersonnelWorkloadSummary {
  userId: string;
  username: string;
  roleName: string;
  assignedScopesCount: number;
  assignedCountriesCount: number;
  assignedStatesCount: number;
  assignedRegionsCount: number;
  subordinateOfficialsCount: number;
  subordinateModeratorsCount: number;
  scopes: Array<{
    scopeType: ScopeType;
    countryId?: string | null;
    countryName?: string | null;
    stateId?: string | null;
    stateName?: string | null;
    regionId?: string | null;
    regionName?: string | null;
  }>;
}

@Injectable()
export class WorkloadService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Computes workload summary metrics for a personnel member
   */
  async getPersonnelWorkload(userId: string): Promise<PersonnelWorkloadSummary> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`Personnel with ID '${userId}' not found`);
    }

    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: {
        role: true,
        roleScopes: {
          include: {
            country: { include: { states: { include: { regions: true } } } },
            state: { include: { regions: true } },
            region: true,
          },
        },
      },
    });

    if (userRoles.length === 0) {
      throw new NotFoundException(`User '${user.username}' has no operational role assigned`);
    }

    const primaryRole = userRoles[0];
    const roleName = primaryRole.role.name;

    let assignedCountriesCount = 0;
    let assignedStatesCount = 0;
    let assignedRegionsCount = 0;
    const countryIds: string[] = [];
    const stateIds: string[] = [];
    const regionIds: string[] = [];

    const formattedScopes = primaryRole.roleScopes.map((s) => {
      if (s.countryId) {
        countryIds.push(s.countryId);
        assignedCountriesCount++;
        if (s.country) {
          assignedStatesCount += s.country.states.length;
          s.country.states.forEach((st) => (assignedRegionsCount += st.regions.length));
        }
      }
      if (s.stateId) {
        stateIds.push(s.stateId);
        assignedStatesCount++;
        if (s.state) {
          assignedRegionsCount += s.state.regions.length;
        }
      }
      if (s.regionId) {
        regionIds.push(s.regionId);
        assignedRegionsCount++;
      }

      return {
        scopeType: s.scopeType,
        countryId: s.countryId,
        countryName: s.country?.name,
        stateId: s.stateId,
        stateName: s.state?.name,
        regionId: s.regionId,
        regionName: s.region?.name,
      };
    });

    // Compute subordinate counts
    let subordinateOfficialsCount = 0;
    let subordinateModeratorsCount = 0;

    if (roleName === 'COUNTRY_MANAGER' && countryIds.length > 0) {
      const [officials, moderators] = await Promise.all([
        this.prisma.roleScope.count({
          where: {
            scopeType: ScopeType.STATE,
            countryId: { in: countryIds },
            userRole: { role: { name: 'OFFICIAL' } },
          },
        }),
        this.prisma.roleScope.count({
          where: {
            scopeType: ScopeType.REGION,
            countryId: { in: countryIds },
            userRole: { role: { name: 'MODERATOR' } },
          },
        }),
      ]);
      subordinateOfficialsCount = officials;
      subordinateModeratorsCount = moderators;
    } else if (roleName === 'OFFICIAL' && stateIds.length > 0) {
      subordinateModeratorsCount = await this.prisma.roleScope.count({
        where: {
          scopeType: ScopeType.REGION,
          stateId: { in: stateIds },
          userRole: { role: { name: 'MODERATOR' } },
        },
      });
    }

    return {
      userId: user.id,
      username: user.username,
      roleName,
      assignedScopesCount: primaryRole.roleScopes.length,
      assignedCountriesCount,
      assignedStatesCount,
      assignedRegionsCount,
      subordinateOfficialsCount,
      subordinateModeratorsCount,
      scopes: formattedScopes,
    };
  }
}
