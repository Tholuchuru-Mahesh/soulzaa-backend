import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WorkforceSearchFilterDto } from '../dto/workforce-query.dto';

export const WORKFORCE_ROLES = [
  'ADMIN',
  'COUNTRY_MANAGER',
  'OFFICIAL',
  'MODERATOR',
  'BUSINESS_DEVELOPMENT',
] as const;

@Injectable()
export class WorkforceQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List and search operational personnel with filtering, pagination, and sorting
   */
  async searchWorkforce(dto: WorkforceSearchFilterDto) {
    const {
      query,
      role,
      countryId,
      stateId,
      regionId,
      accountStatus,
      assignmentStatus,
      dateFrom,
      dateTo,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = dto;

    const skip = (page - 1) * limit;

    // Filter roles to workforce roles only
    const targetRoles = role?.trim() ? [role.trim().toUpperCase()] : WORKFORCE_ROLES;

    // 1. Find UserRole records for target workforce roles and geographic scopes
    const userRoleWhere: any = {
      role: { name: { in: targetRoles } },
    };

    if (countryId || stateId || regionId) {
      userRoleWhere.roleScopes = {
        some: {
          ...(countryId && { countryId }),
          ...(stateId && { stateId }),
          ...(regionId && { regionId }),
        },
      };
    }

    const matchingUserRoles = await this.prisma.userRole.findMany({
      where: userRoleWhere,
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

    const userIds = [...new Set(matchingUserRoles.map((ur) => ur.userId))];

    // 2. Build User query filter
    const where: any = {
      id: { in: userIds },
    };

    if (query?.trim()) {
      const q = query.trim();
      where.OR = [
        { id: { equals: q } },
        { username: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { mobile: { contains: q, mode: 'insensitive' } },
        { fullName: { contains: q, mode: 'insensitive' } },
      ];
    }

    if (accountStatus) {
      where.status = accountStatus;
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    // 3. Count & Select Users
    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: {
          id: true,
          username: true,
          email: true,
          mobile: true,
          fullName: true,
          gender: true,
          country: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    // 4. Map user role & scope details
    const roleMap = new Map<string, any[]>();
    for (const ur of matchingUserRoles) {
      const list = roleMap.get(ur.userId) ?? [];
      list.push({
        userRoleId: ur.id,
        roleId: ur.role.id,
        roleName: ur.role.name,
        displayName: ur.role.displayName,
        assignedAt: ur.createdAt,
        scopes: ur.roleScopes.map((s) => ({
          scopeType: s.scopeType,
          country: s.country
            ? { id: s.country.id, code: s.country.code, name: s.country.name }
            : null,
          state: s.state ? { id: s.state.id, code: s.state.code, name: s.state.name } : null,
          region: s.region ? { id: s.region.id, code: s.region.code, name: s.region.name } : null,
        })),
      });
      roleMap.set(ur.userId, list);
    }

    const items = users
      .map((u) => {
        const roles = roleMap.get(u.id) ?? [];
        const isOperationalActive = u.status === 'ACTIVE' && roles.length > 0;
        return {
          ...u,
          isOperationalActive,
          workforceRoles: roles,
        };
      })
      .filter((u) =>
        assignmentStatus !== undefined ? u.isOperationalActive === assignmentStatus : true,
      );

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }

  /**
   * Get single personnel profile details
   */
  async getWorkforcePersonnelById(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`Personnel with ID '${userId}' not found`);
    }

    const userRoles = await this.prisma.userRole.findMany({
      where: {
        userId,
        role: { name: { in: WORKFORCE_ROLES as any } },
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

    if (userRoles.length === 0) {
      throw new NotFoundException(
        `User '${user.username}' is not assigned to an operational workforce role`,
      );
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      mobile: user.mobile,
      fullName: user.fullName,
      gender: user.gender,
      country: user.country,
      accountStatus: user.status,
      isOperationalActive: user.status === 'ACTIVE',
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      workforceRoles: userRoles.map((ur) => ({
        userRoleId: ur.id,
        roleId: ur.role.id,
        roleName: ur.role.name,
        displayName: ur.role.displayName,
        assignedAt: ur.createdAt,
        scopes: ur.roleScopes.map((s) => ({
          scopeType: s.scopeType,
          country: s.country
            ? { id: s.country.id, code: s.country.code, name: s.country.name }
            : null,
          state: s.state ? { id: s.state.id, code: s.state.code, name: s.state.name } : null,
          region: s.region ? { id: s.region.id, code: s.region.code, name: s.region.name } : null,
        })),
      })),
    };
  }
}
