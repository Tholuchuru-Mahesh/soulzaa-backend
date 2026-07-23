import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
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
    return res;
  }

  async removeRoleFromUser(userId: string, roleId: string) {
    const res = await this.prisma.userRole.deleteMany({
      where: {
        userId,
        roleId,
      },
    });

    await this.cacheService.invalidateUser(userId);
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

  async addRoleHierarchyEdge(dto: CreateRoleHierarchyDto) {
    if (dto.parentRoleId === dto.childRoleId) {
      throw new ConflictException('Parent and Child roles cannot be the same entity');
    }

    return this.prisma.roleHierarchy.upsert({
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
  }

  async removeRoleHierarchyEdge(parentRoleId: string, childRoleId: string) {
    return this.prisma.roleHierarchy.deleteMany({
      where: {
        parentRoleId,
        childRoleId,
      },
    });
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
