import { Injectable } from '@nestjs/common';
import { ScopeType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface HierarchyRegionNode {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  isActive: boolean;
  createdAt: Date;
}

export interface HierarchyStateNode {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  isActive: boolean;
  regionsCount: number;
  regions: HierarchyRegionNode[];
  createdAt: Date;
}

export interface HierarchyCountryNode {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  isActive: boolean;
  statesCount: number;
  regionsCount: number;
  managers: Array<{
    userId: string;
    username: string;
    fullName?: string | null;
    email?: string | null;
  }>;
  states: HierarchyStateNode[];
  createdAt: Date;
}

export interface OrganizationHierarchyResponse {
  totalCountries: number;
  activeCountries: number;
  totalStates: number;
  totalRegions: number;
  hierarchy: HierarchyCountryNode[];
}

@Injectable()
export class OrganizationHierarchyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fetches and compiles the complete organizational hierarchy tree (Country -> State -> Region).
   */
  async getFullHierarchy(): Promise<OrganizationHierarchyResponse> {
    const countries = await this.prisma.country.findMany({
      include: {
        states: {
          include: {
            regions: {
              orderBy: { name: 'asc' },
            },
          },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Fetch assigned Country Managers via RoleScope
    const cmRoleScopes = await this.prisma.roleScope.findMany({
      where: {
        scopeType: ScopeType.COUNTRY,
        countryId: { not: null },
      },
      include: {
        userRole: true,
      },
    });

    const userIds = cmRoleScopes.map((s) => s.userRole.userId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        username: true,
        fullName: true,
        email: true,
      },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    const countryManagerMap = new Map<
      string,
      Array<{ userId: string; username: string; fullName?: string | null; email?: string | null }>
    >();
    for (const scope of cmRoleScopes) {
      if (scope.countryId) {
        const list = countryManagerMap.get(scope.countryId) ?? [];
        const u = userMap.get(scope.userRole.userId);
        if (u) {
          list.push({
            userId: u.id,
            username: u.username,
            fullName: u.fullName,
            email: u.email,
          });
        }
        countryManagerMap.set(scope.countryId, list);
      }
    }

    let totalStates = 0;
    let totalRegions = 0;

    const hierarchyNodes: HierarchyCountryNode[] = countries.map((c) => {
      let countryRegionsCount = 0;

      const stateNodes: HierarchyStateNode[] = c.states.map((s) => {
        totalStates++;
        const regionCount = s.regions.length;
        countryRegionsCount += regionCount;
        totalRegions += regionCount;

        return {
          id: s.id,
          code: s.code,
          name: s.name,
          description: s.description,
          isActive: s.isActive,
          regionsCount: regionCount,
          regions: s.regions.map((r) => ({
            id: r.id,
            code: r.code,
            name: r.name,
            description: r.description,
            isActive: r.isActive,
            createdAt: r.createdAt,
          })),
          createdAt: s.createdAt,
        };
      });

      return {
        id: c.id,
        code: c.code,
        name: c.name,
        description: c.description,
        isActive: c.isActive,
        statesCount: c.states.length,
        regionsCount: countryRegionsCount,
        managers: countryManagerMap.get(c.id) ?? [],
        states: stateNodes,
        createdAt: c.createdAt,
      };
    });

    return {
      totalCountries: countries.length,
      activeCountries: countries.filter((c) => c.isActive).length,
      totalStates,
      totalRegions,
      hierarchy: hierarchyNodes,
    };
  }
}
