import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationCacheService } from 'src/modules/authorization/services/authorization-cache.service';
import { UpdateWorkforceStatusDto } from '../dto/workforce-status.dto';

@Injectable()
export class OperationalStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authCacheService: AuthorizationCacheService,
  ) {}

  /**
   * Resolves detailed operational status card for a workforce member
   */
  async getOperationalStatus(userId: string) {
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
            country: true,
            state: true,
            region: true,
          },
        },
      },
    });

    if (userRoles.length === 0) {
      throw new NotFoundException(`User '${user.username}' has no active workforce role`);
    }

    const primaryRole = userRoles[0];
    const primaryScope = primaryRole.roleScopes[0];

    // Resolve Reporting Manager
    let reportingManager: { userId: string; username: string; roleName: string } | null = null;

    if (primaryRole.role.name === 'MODERATOR' && primaryScope?.stateId) {
      const officialScope = await this.prisma.roleScope.findFirst({
        where: {
          stateId: primaryScope.stateId,
          userRole: { role: { name: 'OFFICIAL' } },
        },
        include: { userRole: true },
      });
      if (officialScope) {
        const offUser = await this.prisma.user.findUnique({
          where: { id: officialScope.userRole.userId },
        });
        if (offUser) {
          reportingManager = {
            userId: offUser.id,
            username: offUser.username,
            roleName: 'OFFICIAL',
          };
        }
      }
    } else if (primaryRole.role.name === 'OFFICIAL' && primaryScope?.countryId) {
      const cmScope = await this.prisma.roleScope.findFirst({
        where: {
          countryId: primaryScope.countryId,
          userRole: { role: { name: 'COUNTRY_MANAGER' } },
        },
        include: { userRole: true },
      });
      if (cmScope) {
        const cmUser = await this.prisma.user.findUnique({
          where: { id: cmScope.userRole.userId },
        });
        if (cmUser) {
          reportingManager = {
            userId: cmUser.id,
            username: cmUser.username,
            roleName: 'COUNTRY_MANAGER',
          };
        }
      }
    }

    return {
      userId: user.id,
      username: user.username,
      accountStatus: user.status,
      isOperationalActive: user.status === AccountStatus.ACTIVE,
      roleName: primaryRole.role.name,
      displayName: primaryRole.role.displayName,
      assignmentDate: primaryRole.createdAt,
      lastAssignmentChange: primaryRole.updatedAt,
      reportingManager,
      assignedScope: primaryScope
        ? {
            scopeType: primaryScope.scopeType,
            country: primaryScope.country
              ? { id: primaryScope.country.id, name: primaryScope.country.name }
              : null,
            state: primaryScope.state
              ? { id: primaryScope.state.id, name: primaryScope.state.name }
              : null,
            region: primaryScope.region
              ? { id: primaryScope.region.id, name: primaryScope.region.name }
              : null,
          }
        : null,
    };
  }

  /**
   * Activates or Deactivates personnel operational status
   */
  async updateOperationalStatus(userId: string, dto: UpdateWorkforceStatusDto, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`Personnel with ID '${userId}' not found`);
    }

    const newStatus = dto.isActive ? AccountStatus.ACTIVE : AccountStatus.INACTIVE;

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: newStatus,
        updatedBy: actorId,
      },
    });

    await this.authCacheService.invalidateUser(userId);

    return {
      message: `Operational status for personnel '${user.username}' updated to '${newStatus}' successfully`,
      userId: user.id,
      previousStatus: user.status,
      newStatus: updatedUser.status,
      reason: dto.reason,
    };
  }
}
