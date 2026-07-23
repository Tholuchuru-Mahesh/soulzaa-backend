import { Injectable } from '@nestjs/common';
import { ScopeType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface ModeratorNode {
  userId: string;
  username: string;
  fullName?: string | null;
  regionId?: string | null;
  regionName?: string | null;
}

export interface OfficialNode {
  userId: string;
  username: string;
  fullName?: string | null;
  stateId?: string | null;
  stateName?: string | null;
  moderators: ModeratorNode[];
}

export interface CountryManagerNode {
  userId: string;
  username: string;
  fullName?: string | null;
  countryId?: string | null;
  countryName?: string | null;
  officials: OfficialNode[];
}

export interface AdminNode {
  userId: string;
  username: string;
  fullName?: string | null;
  countryManagers: CountryManagerNode[];
}

export interface ReportingHierarchyResponse {
  superAdminCount: number;
  adminCount: number;
  countryManagerCount: number;
  officialCount: number;
  moderatorCount: number;
  hierarchy: AdminNode[];
}

@Injectable()
export class ReportingHierarchyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the full operational reporting hierarchy tree
   * SUPER_ADMIN -> ADMIN -> COUNTRY_MANAGER -> OFFICIAL -> MODERATOR
   */
  async getReportingHierarchy(): Promise<ReportingHierarchyResponse> {
    // 1. Fetch all personnel userRoles for operational roles
    const workforceUserRoles = await this.prisma.userRole.findMany({
      where: {
        role: {
          name: { in: ['SUPER_ADMIN', 'ADMIN', 'COUNTRY_MANAGER', 'OFFICIAL', 'MODERATOR'] },
        },
      },
      include: {
        role: true,
        roleScopes: {
          include: {
            country: true,
            state: true,
            region: true,
          },
        },
      },
    });

    const userIds = [...new Set(workforceUserRoles.map((ur) => ur.userId))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, fullName: true, status: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    // Categorize by role
    const superAdmins: any[] = [];
    const admins: any[] = [];
    const countryManagers: any[] = [];
    const officials: any[] = [];
    const moderators: any[] = [];

    for (const ur of workforceUserRoles) {
      const u = userMap.get(ur.userId);
      if (!u) continue;
      const primaryScope = ur.roleScopes[0];

      const item = {
        userId: u.id,
        username: u.username,
        fullName: u.fullName,
        countryId: primaryScope?.countryId,
        countryName: primaryScope?.country?.name,
        stateId: primaryScope?.stateId,
        stateName: primaryScope?.state?.name,
        regionId: primaryScope?.regionId,
        regionName: primaryScope?.region?.name,
      };

      if (ur.role.name === 'SUPER_ADMIN') superAdmins.push(item);
      else if (ur.role.name === 'ADMIN') admins.push(item);
      else if (ur.role.name === 'COUNTRY_MANAGER') countryManagers.push(item);
      else if (ur.role.name === 'OFFICIAL') officials.push(item);
      else if (ur.role.name === 'MODERATOR') moderators.push(item);
    }

    // Build hierarchy links by geographic boundaries
    const hierarchy: AdminNode[] = admins.map((admin) => {
      const cms: CountryManagerNode[] = countryManagers.map((cm) => {
        // Officials under same country
        const childOfficials: OfficialNode[] = officials
          .filter((off) => off.countryId === cm.countryId || !cm.countryId)
          .map((off) => {
            // Moderators under same state
            const childMods: ModeratorNode[] = moderators
              .filter((mod) => mod.stateId === off.stateId || !off.stateId)
              .map((mod) => ({
                userId: mod.userId,
                username: mod.username,
                fullName: mod.fullName,
                regionId: mod.regionId,
                regionName: mod.regionName,
              }));

            return {
              userId: off.userId,
              username: off.username,
              fullName: off.fullName,
              stateId: off.stateId,
              stateName: off.stateName,
              moderators: childMods,
            };
          });

        return {
          userId: cm.userId,
          username: cm.username,
          fullName: cm.fullName,
          countryId: cm.countryId,
          countryName: cm.countryName,
          officials: childOfficials,
        };
      });

      return {
        userId: admin.userId,
        username: admin.username,
        fullName: admin.fullName,
        countryManagers: cms,
      };
    });

    return {
      superAdminCount: superAdmins.length,
      adminCount: admins.length,
      countryManagerCount: countryManagers.length,
      officialCount: officials.length,
      moderatorCount: moderators.length,
      hierarchy,
    };
  }
}
