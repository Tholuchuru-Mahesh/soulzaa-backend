import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { AuthorizationCacheService } from 'src/modules/authorization/services/authorization-cache.service';
import { AuthorizationService } from 'src/modules/authorization/services/authorization.service';
import { RoleService } from 'src/modules/authorization/services/role.service';
import { CountryService } from 'src/modules/organization/services/country.service';
import { RegionService } from 'src/modules/organization/services/region.service';
import { StateService } from 'src/modules/organization/services/state.service';
import { AccountLifecycleService } from './account-lifecycle.service';
import { RoleAssignmentService } from './role-assignment.service';
import { UserQueryService } from './user-query.service';

describe('Super Admin Phase 2B: User & Role Management Services', () => {
  let queryService: UserQueryService;
  let roleAssignmentService: RoleAssignmentService;
  let lifecycleService: AccountLifecycleService;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    role: {
      findFirst: jest.fn(),
    },
    userRole: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    roleScope: {
      findFirst: jest.fn(),
    },
    auditLog: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  const mockRoleService = {
    assignRoleToUser: jest.fn(),
    assignRoleScope: jest.fn(),
    removeRoleFromUser: jest.fn(),
  };

  const mockCountryService = {
    getCountryById: jest.fn(),
  };

  const mockStateService = {
    getStateById: jest.fn(),
  };

  const mockRegionService = {
    getRegionById: jest.fn(),
  };

  const mockAuthorizationService = {
    getEffectivePermissions: jest.fn(),
  };

  const mockAuthCacheService = {
    invalidateUser: jest.fn(),
  };

  const mockCacheService = {
    del: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserQueryService,
        RoleAssignmentService,
        AccountLifecycleService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RoleService, useValue: mockRoleService },
        { provide: CountryService, useValue: mockCountryService },
        { provide: StateService, useValue: mockStateService },
        { provide: RegionService, useValue: mockRegionService },
        { provide: AuthorizationService, useValue: mockAuthorizationService },
        { provide: AuthorizationCacheService, useValue: mockAuthCacheService },
        { provide: CacheService, useValue: mockCacheService },
      ],
    }).compile();

    queryService = module.get<UserQueryService>(UserQueryService);
    roleAssignmentService = module.get<RoleAssignmentService>(RoleAssignmentService);
    lifecycleService = module.get<AccountLifecycleService>(AccountLifecycleService);

    jest.clearAllMocks();
  });

  describe('UserQueryService', () => {
    it('should search users with pagination and filtering', async () => {
      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([
        {
          id: 'u-1',
          username: 'john_doe',
          email: 'john@example.com',
          status: AccountStatus.ACTIVE,
        },
      ]);
      mockPrismaService.userRole.findMany.mockResolvedValue([]);

      const result = await queryService.searchUsers({ query: 'john', page: 1, limit: 10 });
      expect(result.total).toBe(1);
      expect(result.items.length).toBe(1);
      expect(result.items[0].username).toBe('john_doe');
    });

    it('should retrieve detailed user profile', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'u-1',
        username: 'john_doe',
        status: AccountStatus.ACTIVE,
      });
      mockPrismaService.userRole.findMany.mockResolvedValue([]);
      mockAuthorizationService.getEffectivePermissions.mockResolvedValue(['user.view']);
      mockPrismaService.auditLog.findMany.mockResolvedValue([]);

      const profile = await queryService.getUserProfileDetails('u-1');
      expect(profile.username).toBe('john_doe');
      expect(profile.inheritedPermissions).toEqual(['user.view']);
    });
  });

  describe('RoleAssignmentService', () => {
    it('should throw ForbiddenException if non-SuperAdmin attempts to assign ADMIN role', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u-1', username: 'target' });
      mockPrismaService.role.findFirst.mockResolvedValue({ id: 'r-admin', name: 'ADMIN' });

      await expect(
        roleAssignmentService.assignRole('u-1', { role: 'ADMIN' }, 'actor-1', ['ADMIN']),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should assign role successfully when actor is SUPER_ADMIN', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u-1', username: 'target' });
      mockPrismaService.role.findFirst.mockResolvedValue({ id: 'r-mod', name: 'MODERATOR' });
      mockPrismaService.userRole.findUnique.mockResolvedValue(null);
      mockRoleService.assignRoleToUser.mockResolvedValue({
        id: 'ur-1',
        userId: 'u-1',
        roleId: 'r-mod',
      });

      const res = await roleAssignmentService.assignRole('u-1', { role: 'MODERATOR' }, 'actor-1', [
        'SUPER_ADMIN',
      ]);
      expect(res.roleName).toBe('MODERATOR');
      expect(mockAuthCacheService.invalidateUser).toHaveBeenCalledWith('u-1');
    });
  });

  describe('AccountLifecycleService', () => {
    it('should suspend account and force logout sessions', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'u-1',
        username: 'target',
        status: AccountStatus.ACTIVE,
      });
      mockPrismaService.user.update.mockResolvedValue({
        id: 'u-1',
        status: AccountStatus.SUSPENDED,
      });

      const res = await lifecycleService.suspendAccount('u-1', { reason: 'Violation' }, 'actor-1');

      expect(res.newStatus).toBe(AccountStatus.SUSPENDED);
      expect(mockCacheService.del).toHaveBeenCalledWith('session:user:u-1');
      expect(mockAuthCacheService.invalidateUser).toHaveBeenCalledWith('u-1');
    });

    it('should throw BadRequestException when unlocking an account that is already active', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'u-1',
        username: 'target',
        status: AccountStatus.ACTIVE,
      });

      await expect(lifecycleService.unlockAccount('u-1', 'actor-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
