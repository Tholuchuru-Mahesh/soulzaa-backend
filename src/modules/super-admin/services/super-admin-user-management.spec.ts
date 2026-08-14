import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountStatus, ScopeType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { CacheService } from 'src/infra/redis/cache.service';
import { AuthorizationCacheService } from 'src/modules/authorization/services/authorization-cache.service';
import { AuthorizationService } from 'src/modules/authorization/services/authorization.service';
import {
  PolicyEngineService,
  RoleRankPolicyRule,
} from 'src/modules/authorization/services/policy-engine.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
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
    // getUserProfileDetails fans out over the whole profile in one Promise.all,
    // so every model it touches needs a stub here — a missing one surfaces as
    // "Cannot read properties of undefined" rather than as a null result.
    // The defaults matter too: the method maps over each findMany result, so an
    // unstubbed resolution (undefined) throws instead of yielding an empty list.
    userStatistics: { findUnique: jest.fn().mockResolvedValue(null) },
    referralRelationship: { findUnique: jest.fn().mockResolvedValue(null) },
    userVerification: { findUnique: jest.fn().mockResolvedValue(null) },
    familyMember: { findUnique: jest.fn().mockResolvedValue(null) },
    family: { findUnique: jest.fn().mockResolvedValue(null) },
    agencyRelationship: { findFirst: jest.fn().mockResolvedValue(null) },
    wallet: { findUnique: jest.fn().mockResolvedValue(null) },
    walletTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    purchaseOrder: { findMany: jest.fn().mockResolvedValue([]) },
    giftTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    gift: { findMany: jest.fn().mockResolvedValue([]) },
    roomLog: { findMany: jest.fn().mockResolvedValue([]) },
    videoRoomLog: { findMany: jest.fn().mockResolvedValue([]) },
    audioRoom: { findMany: jest.fn().mockResolvedValue([]) },
    gameParticipant: { findMany: jest.fn().mockResolvedValue([]) },
    gameDefinition: { findMany: jest.fn().mockResolvedValue([]) },
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

  const mockRoleResolver = {
    hasRole: jest.fn(),
    getRoleNames: jest.fn(),
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
        { provide: RoleResolver, useValue: mockRoleResolver },
        { provide: MediaUrlResolver, useValue: { resolveAvatarUrl: jest.fn() } },
        PolicyEngineService,
        RoleRankPolicyRule,
      ],
    }).compile();

    queryService = module.get<UserQueryService>(UserQueryService);
    roleAssignmentService = module.get<RoleAssignmentService>(RoleAssignmentService);
    lifecycleService = module.get<AccountLifecycleService>(AccountLifecycleService);
    module.get(PolicyEngineService).onModuleInit();

    jest.clearAllMocks();

    // Rank enforcement has its own suite (privileged-action-policy.spec.ts); a
    // SUPER_ADMIN actor keeps it out of the way of the cases exercised here.
    mockRoleResolver.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
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
      mockRoleResolver.hasRole.mockResolvedValue(false);

      await expect(
        roleAssignmentService.assignRole('u-1', { role: 'ADMIN' }, 'actor-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should assign role successfully when actor is SUPER_ADMIN', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u-1', username: 'target' });
      mockPrismaService.role.findFirst.mockResolvedValue({ id: 'r-mod', name: 'MODERATOR' });
      mockPrismaService.userRole.findUnique.mockResolvedValue(null);
      mockRoleResolver.hasRole.mockResolvedValue(true);
      mockRoleService.assignRoleToUser.mockResolvedValue({
        id: 'ur-1',
        userId: 'u-1',
        roleId: 'r-mod',
      });

      const res = await roleAssignmentService.assignRole('u-1', { role: 'MODERATOR' }, 'actor-1');
      expect(res.roleName).toBe('MODERATOR');
      expect(mockAuthCacheService.invalidateUser).toHaveBeenCalledWith('u-1');
    });

    describe('single Country Manager per country', () => {
      /**
       * Stands in for the database honouring the `where` clause: the country already
       * has a country-scoped BUSINESS_DEVELOPMENT assignment, which must not be
       * mistaken for an incumbent Country Manager.
       */
      const countryHeldByBusinessDevelopment = () =>
        mockPrismaService.roleScope.findFirst.mockImplementation(
          ({ where }: { where: { userRole?: { roleId?: string } } }) => {
            const row = { userRole: { userId: 'other-user', roleId: 'r-bd' } };
            const wanted = where.userRole?.roleId;
            return Promise.resolve(wanted && wanted !== row.userRole.roleId ? null : row);
          },
        );

      beforeEach(() => {
        mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u-1', username: 'target' });
        mockPrismaService.userRole.findUnique.mockResolvedValue(null);
        mockRoleResolver.hasRole.mockResolvedValue(true);
        mockCountryService.getCountryById.mockResolvedValue({
          id: 'c-1',
          name: 'India',
          isActive: true,
        });
        mockRoleService.assignRoleToUser.mockResolvedValue({ id: 'ur-1' });
      });

      it('allows a Country Manager when another role already holds a country scope there', async () => {
        mockPrismaService.role.findFirst.mockResolvedValue({
          id: 'r-cm',
          name: 'COUNTRY_MANAGER',
        });
        countryHeldByBusinessDevelopment();

        const res = await roleAssignmentService.assignRole(
          'u-1',
          { role: 'COUNTRY_MANAGER', scopeType: ScopeType.COUNTRY, countryId: 'c-1' },
          'actor-1',
        );

        expect(res.roleName).toBe('COUNTRY_MANAGER');
      });

      it('still rejects a second Country Manager for the same country', async () => {
        mockPrismaService.role.findFirst.mockResolvedValue({
          id: 'r-cm',
          name: 'COUNTRY_MANAGER',
        });
        mockPrismaService.roleScope.findFirst.mockResolvedValue({
          userRole: { userId: 'incumbent', roleId: 'r-cm' },
        });

        await expect(
          roleAssignmentService.assignRole(
            'u-1',
            { role: 'COUNTRY_MANAGER', scopeType: ScopeType.COUNTRY, countryId: 'c-1' },
            'actor-1',
          ),
        ).rejects.toThrow(ConflictException);
      });
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
