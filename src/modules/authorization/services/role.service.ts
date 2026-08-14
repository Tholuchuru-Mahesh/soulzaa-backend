import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from '../../../common/events';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RoleAssignedEvent, RoleRevokedEvent } from '../events/role.events';
import { AssignRoleDto } from '../dto/assign-role.dto';
import { CreateRoleDto } from '../dto/create-role.dto';
import { CreateRoleHierarchyDto } from '../dto/role-hierarchy.dto';
import { CreateRoleScopeDto } from '../dto/create-scope.dto';
import { AuthorizationCacheService } from './authorization-cache.service';

@Injectable()
export class RoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: AuthorizationCacheService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async createRole(dto: CreateRoleDto): Promise<Role> {
    const existing = await this.prisma.role.findUnique({
      where: { name: dto.name },
    });
    if (existing) {
      throw new ConflictException(`Role with name '${dto.name}' already exists`);
    }

    return this.prisma.role.create({
      data: {
        name: dto.name,
        displayName: dto.displayName,
        description: dto.description,
        isSystem: dto.isSystem ?? false,
      },
    });
  }

  async getAllRoles(): Promise<Role[]> {
    return this.prisma.role.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async getRoleByName(name: string): Promise<Role> {
    const role = await this.prisma.role.findUnique({ where: { name } });
    if (!role) {
      throw new NotFoundException(`Role '${name}' not found`);
    }
    return role;
  }

  async assignRoleToUser(dto: AssignRoleDto, assignedByUserId?: string) {
    const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
    if (!role) {
      throw new NotFoundException(`Role with ID '${dto.roleId}' not found`);
    }

    const res = await this.prisma.userRole.upsert({
      where: {
        userId_roleId: {
          userId: dto.userId,
          roleId: dto.roleId,
        },
      },
      create: {
        userId: dto.userId,
        roleId: dto.roleId,
        assignedBy: assignedByUserId,
      },
      update: {
        assignedBy: assignedByUserId,
      },
    });

    await this.cacheService.invalidateUser(dto.userId);
    // Published after the cache is invalidated, so a subscriber that re-reads
    // roles (e.g. the hidden-account sync) sees the assignment it was told about.
    await this.bus.publish(
      new RoleAssignedEvent({
        userId: dto.userId,
        roleId: dto.roleId,
        actorId: assignedByUserId ?? null,
      }),
    );
    return res;
  }

  /**
   * Assign by role *name*. Callers that think in roles ("make this account an
   * ADMIN") should not have to resolve a UUID first — and resolving it
   * themselves would mean reading the roles table from outside this module.
   */
  async assignRoleByName(userId: string, roleName: string, assignedByUserId?: string) {
    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      throw new NotFoundException(`Role '${roleName}' not found`);
    }
    return this.assignRoleToUser({ userId, roleId: role.id }, assignedByUserId);
  }

  async removeRoleFromUser(userId: string, roleId: string) {
    const res = await this.prisma.userRole.deleteMany({
      where: {
        userId,
        roleId,
      },
    });

    await this.cacheService.invalidateUser(userId);
    await this.bus.publish(new RoleRevokedEvent({ userId, roleId, actorId: null }));
    return res;
  }

  async getUserRoles(userId: string) {
    return this.prisma.userRole.findMany({
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
  }

  /**
   * Invalidates every user whose resolved roles change when an edge under
   * `parentRoleId` is added or removed. That is the parent itself plus all of its
   * ancestors, since each inherits transitively through the edge. Descendants are
   * unaffected — inheritance only ever flows downward.
   *
   * The upward walk is a fixpoint over the edge list, so a cycle in the hierarchy
   * terminates rather than recursing forever.
   */
  private async invalidateHierarchyAffectedUsers(parentRoleId: string): Promise<void> {
    const edges = await this.prisma.roleHierarchy.findMany({
      select: { parentRoleId: true, childRoleId: true },
    });

    const affectedRoleIds = new Set<string>([parentRoleId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of edges) {
        if (affectedRoleIds.has(edge.childRoleId) && !affectedRoleIds.has(edge.parentRoleId)) {
          affectedRoleIds.add(edge.parentRoleId);
          grew = true;
        }
      }
    }

    const holders = await this.prisma.userRole.findMany({
      where: { roleId: { in: Array.from(affectedRoleIds) } },
      select: { userId: true },
      distinct: ['userId'],
    });

    await Promise.all(holders.map((h) => this.cacheService.invalidateUser(h.userId)));
  }

  async addRoleHierarchyEdge(dto: CreateRoleHierarchyDto) {
    if (dto.parentRoleId === dto.childRoleId) {
      throw new ConflictException('Parent and Child roles cannot be the same entity');
    }

    const edge = await this.prisma.roleHierarchy.upsert({
      where: {
        parentRoleId_childRoleId: {
          parentRoleId: dto.parentRoleId,
          childRoleId: dto.childRoleId,
        },
      },
      create: {
        parentRoleId: dto.parentRoleId,
        childRoleId: dto.childRoleId,
      },
      update: {},
    });

    await this.invalidateHierarchyAffectedUsers(dto.parentRoleId);
    return edge;
  }

  async removeRoleHierarchyEdge(parentRoleId: string, childRoleId: string) {
    const result = await this.prisma.roleHierarchy.deleteMany({
      where: {
        parentRoleId,
        childRoleId,
      },
    });

    await this.invalidateHierarchyAffectedUsers(parentRoleId);
    return result;
  }

  async getRoleHierarchy() {
    return this.prisma.roleHierarchy.findMany({
      include: {
        parentRole: true,
        childRole: true,
      },
    });
  }

  async assignRoleScope(dto: CreateRoleScopeDto) {
    const userRole = await this.prisma.userRole.findUnique({
      where: { id: dto.userRoleId },
    });
    if (!userRole) {
      throw new NotFoundException(`UserRole with ID '${dto.userRoleId}' not found`);
    }

    const res = await this.prisma.roleScope.create({
      data: {
        userRoleId: dto.userRoleId,
        scopeType: dto.scopeType,
        countryId: dto.countryId,
        stateId: dto.stateId,
        regionId: dto.regionId,
      },
    });

    await this.cacheService.invalidateUser(userRole.userId);
    return res;
  }

  async removeRoleScope(scopeId: string) {
    const scope = await this.prisma.roleScope.findUnique({
      where: { id: scopeId },
      include: { userRole: true },
    });

    const res = await this.prisma.roleScope.delete({
      where: { id: scopeId },
    });

    if (scope?.userRole?.userId) {
      await this.cacheService.invalidateUser(scope.userRole.userId);
    }
    return res;
  }
}
