import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationService } from 'src/modules/authorization/services/authorization.service';
import { UserSearchFilterDto } from '../dto/user-query.dto';
import { maskPrivilegedRole } from './role-masking.util';

@Injectable()
export class UserQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  /**
   * Complex User Search & Filtering with Pagination & Sorting
   */
  /**
   * `viewerIsSuperAdmin` gates role masking — an Admin must not be able to
   * identify a Super Admin (spec §1). Defaults to false so a caller that
   * forgets to pass it masks rather than leaks.
   */
  async searchUsers(dto: UserSearchFilterDto, viewerIsSuperAdmin = false) {
    const {
      query,
      role,
      countryId,
      stateId,
      regionId,
      status,
      dateFrom,
      dateTo,
      createdBy,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = dto;

    const skip = (page - 1) * limit;
    const where: any = {};

    // 1. Text Search across multiple fields
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

    // 2. Filter by Account Status
    if (status) {
      where.status = status;
    }

    // 3. Filter by Registration Date
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    // 4. Filter by CreatedBy
    if (createdBy) {
      where.createdBy = createdBy;
    }

    // 5. Filter by Assigned Role & Geographic Scope via UserRole
    const userRoleWhere: any = {};
    if (role?.trim()) {
      userRoleWhere.role = {
        name: { equals: role.trim().toUpperCase() },
      };
    }

    if (countryId || stateId || regionId) {
      userRoleWhere.roleScopes = {
        some: {
          ...(countryId && { countryId }),
          ...(stateId && { stateId }),
          ...(regionId && { regionId }),
        },
      };
    }

    if (Object.keys(userRoleWhere).length > 0) {
      const matchingUserRoles = await this.prisma.userRole.findMany({
        where: userRoleWhere,
        select: { userId: true },
      });
      const matchedUserIds = matchingUserRoles.map((ur) => ur.userId);
      where.id = { in: matchedUserIds };
    }

    // 6. Execute Count & Select Queries
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
          isGuest: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    // 7. Attach User Roles & Scopes
    const userIds = users.map((u) => u.id);
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId: { in: userIds } },
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

    const roleMap = new Map<string, any[]>();
    for (const ur of userRoles) {
      const list = roleMap.get(ur.userId) ?? [];
      list.push({
        id: ur.role.id,
        name: maskPrivilegedRole(ur.role.name, viewerIsSuperAdmin),
        displayName: ur.role.displayName,
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

    const items = users.map((u) => ({
      ...u,
      assignedRoles: roleMap.get(u.id) ?? [],
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }

  /**
   * Detailed User Profile Inspection (Roles, Inherited Permissions, Scopes, Audit Logs)
   */
  /** See searchUsers for why `viewerIsSuperAdmin` defaults to false. */
  async getUserProfileDetails(userId: string, viewerIsSuperAdmin = false) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found`);
    }

    const [userRoles, effectivePermissions, recentAuditLogs] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId },
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
      }),
      this.authorizationService.getEffectivePermissions(userId),
      this.prisma.auditLog.findMany({
        where: {
          OR: [{ actorId: userId }, { resourceId: userId }],
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const formattedRoles = userRoles.map((ur) => ({
      userRoleId: ur.id,
      roleId: ur.role.id,
      roleName: maskPrivilegedRole(ur.role.name, viewerIsSuperAdmin),
      displayName: ur.role.displayName,
      description: ur.role.description,
      assignedAt: ur.createdAt,
      scopes: ur.roleScopes.map((s) => ({
        scopeType: s.scopeType,
        country: s.country
          ? { id: s.country.id, code: s.country.code, name: s.country.name }
          : null,
        state: s.state ? { id: s.state.id, code: s.state.code, name: s.state.name } : null,
        region: s.region ? { id: s.region.id, code: s.region.code, name: s.region.name } : null,
      })),
    }));

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      mobile: user.mobile,
      fullName: user.fullName,
      gender: user.gender,
      dateOfBirth: user.dateOfBirth,
      country: user.country,
      preferredLanguage: user.preferredLanguage,
      status: user.status,
      isGuest: user.isGuest,
      emailVerifiedAt: user.emailVerifiedAt,
      mobileVerifiedAt: user.mobileVerifiedAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      assignedRoles: formattedRoles,
      inheritedPermissions: effectivePermissions,
      recentAuditLogs,
    };
  }

  /**
   * User Audit Logs History
   */
  async getUserAuditHistory(userId: string, page = 1, limit = 20) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found`);
    }

    const skip = (page - 1) * limit;

    const where = {
      OR: [{ actorId: userId }, { resourceId: userId }],
    };

    const [total, logs] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      logs,
    };
  }
}
