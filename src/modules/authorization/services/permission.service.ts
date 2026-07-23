import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AssignPermissionDto } from '../dto/assign-permission.dto';
import { CreatePermissionDto } from '../dto/create-permission.dto';
import { AuthorizationCacheService } from './authorization-cache.service';

@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: AuthorizationCacheService,
  ) {}

  async createPermission(dto: CreatePermissionDto): Promise<Permission> {
    const existing = await this.prisma.permission.findUnique({
      where: { code: dto.code },
    });
    if (existing) {
      throw new ConflictException(`Permission with code '${dto.code}' already exists`);
    }

    return this.prisma.permission.create({
      data: {
        code: dto.code,
        module: dto.module,
        action: dto.action,
        category: dto.category || 'SYSTEM',
        displayName: dto.displayName,
        description: dto.description,
      },
    });
  }

  async getAllPermissions(category?: string): Promise<Permission[]> {
    const where = category ? { category } : {};
    return this.prisma.permission.findMany({
      where,
      orderBy: [{ category: 'asc' }, { module: 'asc' }, { code: 'asc' }],
    });
  }

  async getPermissionByCode(code: string): Promise<Permission> {
    const perm = await this.prisma.permission.findUnique({ where: { code } });
    if (!perm) {
      throw new NotFoundException(`Permission with code '${code}' not found`);
    }
    return perm;
  }

  async assignPermissionToRole(dto: AssignPermissionDto) {
    const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
    if (!role) {
      throw new NotFoundException(`Role with ID '${dto.roleId}' not found`);
    }

    const perm = await this.prisma.permission.findUnique({ where: { id: dto.permissionId } });
    if (!perm) {
      throw new NotFoundException(`Permission with ID '${dto.permissionId}' not found`);
    }

    const res = await this.prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: dto.roleId,
          permissionId: dto.permissionId,
        },
      },
      create: {
        roleId: dto.roleId,
        permissionId: dto.permissionId,
      },
      update: {},
    });

    // Invalidate authorization cache for users assigned to this role
    const userRoles = await this.prisma.userRole.findMany({
      where: { roleId: dto.roleId },
      select: { userId: true },
    });
    for (const ur of userRoles) {
      await this.cacheService.invalidateUser(ur.userId);
    }

    return res;
  }

  async removePermissionFromRole(roleId: string, permissionId: string) {
    const userRoles = await this.prisma.userRole.findMany({
      where: { roleId },
      select: { userId: true },
    });

    const res = await this.prisma.rolePermission.deleteMany({
      where: {
        roleId,
        permissionId,
      },
    });

    for (const ur of userRoles) {
      await this.cacheService.invalidateUser(ur.userId);
    }
    return res;
  }

  async getRolePermissions(roleId: string) {
    return this.prisma.rolePermission.findMany({
      where: { roleId },
      include: { permission: true },
    });
  }
}
