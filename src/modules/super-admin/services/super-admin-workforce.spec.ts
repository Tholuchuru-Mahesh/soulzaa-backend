import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountStatus, ScopeType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationCacheService } from 'src/modules/authorization/services/authorization-cache.service';
import { RoleService } from 'src/modules/authorization/services/role.service';
import { CountryService } from 'src/modules/organization/services/country.service';
import { RegionService } from 'src/modules/organization/services/region.service';
import { StateService } from 'src/modules/organization/services/state.service';
import { OperationalStatusService } from './operational-status.service';
import { ReportingHierarchyService } from './reporting-hierarchy.service';
import { WorkforceAssignmentService } from './workforce-assignment.service';
import { WorkforceQueryService } from './workforce-query.service';
import { WorkloadService } from './workload.service';

describe('Super Admin Phase 2C: Workforce & Personnel Management Services', () => {
  let queryService: WorkforceQueryService;
  let assignmentService: WorkforceAssignmentService;
  let hierarchyService: ReportingHierarchyService;
  let workloadService: WorkloadService;
  let statusService: OperationalStatusService;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    role: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    userRole: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    roleScope: {
      findFirst: jest.fn(),
      count: jest.fn(),
      deleteMany: jest.fn(),
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

  const mockAuthCacheService = {
    invalidateUser: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkforceQueryService,
        WorkforceAssignmentService,
        ReportingHierarchyService,
        WorkloadService,
        OperationalStatusService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RoleService, useValue: mockRoleService },
        { provide: CountryService, useValue: mockCountryService },
        { provide: StateService, useValue: mockStateService },
        { provide: RegionService, useValue: mockRegionService },
        { provide: AuthorizationCacheService, useValue: mockAuthCacheService },
      ],
    }).compile();

    queryService = module.get<WorkforceQueryService>(WorkforceQueryService);
    assignmentService = module.get<WorkforceAssignmentService>(WorkforceAssignmentService);
    hierarchyService = module.get<ReportingHierarchyService>(ReportingHierarchyService);
    workloadService = module.get<WorkloadService>(WorkloadService);
    statusService = module.get<OperationalStatusService>(OperationalStatusService);

    jest.clearAllMocks();
  });

  describe('WorkforceQueryService', () => {
    it('should search workforce personnel matching specified filters', async () => {
      mockPrismaService.userRole.findMany.mockResolvedValue([
        {
          userId: 'u-off',
          role: { id: 'r-off', name: 'OFFICIAL', displayName: 'Official' },
          roleScopes: [],
          createdAt: new Date(),
        },
      ]);
      mockPrismaService.user.count.mockResolvedValue(1);
      mockPrismaService.user.findMany.mockResolvedValue([
        {
          id: 'u-off',
          username: 'official_user',
          status: AccountStatus.ACTIVE,
          createdAt: new Date(),
        },
      ]);

      const result = await queryService.searchWorkforce({ role: 'OFFICIAL', page: 1, limit: 10 });

      expect(result.total).toBe(1);
      expect(result.items[0].username).toBe('official_user');
      expect(result.items[0].isOperationalActive).toBe(true);
    });
  });

  describe('WorkforceAssignmentService', () => {
    it('should assign workforce role and state scope to Official', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'u-off',
        username: 'official_user',
        status: AccountStatus.ACTIVE,
      });
      mockPrismaService.role.findUnique.mockResolvedValue({ id: 'r-off', name: 'OFFICIAL' });
      mockStateService.getStateById.mockResolvedValue({
        id: 's-1',
        name: 'Karnataka',
        isActive: true,
      });
      mockRoleService.assignRoleToUser.mockResolvedValue({
        id: 'ur-1',
        userId: 'u-off',
        roleId: 'r-off',
      });

      const res = await assignmentService.assignWorkforce(
        { userId: 'u-off', role: 'OFFICIAL', scopeType: ScopeType.STATE, stateId: 's-1' },
        'actor-1',
      );

      expect(res.roleName).toBe('OFFICIAL');
      expect(res.scopeType).toBe(ScopeType.STATE);
      expect(mockAuthCacheService.invalidateUser).toHaveBeenCalledWith('u-off');
    });

    it('should throw BadRequestException if target user is not active', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'u-off',
        username: 'official_user',
        status: AccountStatus.SUSPENDED,
      });

      await expect(
        assignmentService.assignWorkforce(
          { userId: 'u-off', role: 'OFFICIAL', scopeType: ScopeType.STATE, stateId: 's-1' },
          'actor-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('ReportingHierarchyService', () => {
    it('should compile operational reporting tree', async () => {
      mockPrismaService.userRole.findMany.mockResolvedValue([]);
      mockPrismaService.user.findMany.mockResolvedValue([]);

      const tree = await hierarchyService.getReportingHierarchy();

      expect(tree.adminCount).toBe(0);
      expect(tree.hierarchy).toEqual([]);
    });
  });

  describe('WorkloadService', () => {
    it('should calculate personnel workload metrics', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u-cm', username: 'cm_user' });
      mockPrismaService.userRole.findMany.mockResolvedValue([
        {
          role: { name: 'COUNTRY_MANAGER' },
          roleScopes: [
            {
              scopeType: ScopeType.COUNTRY,
              countryId: 'c-1',
              country: { name: 'India', states: [{ id: 's-1', regions: [{ id: 'r-1' }] }] },
            },
          ],
        },
      ]);
      mockPrismaService.roleScope.count.mockResolvedValue(2);

      const workload = await workloadService.getPersonnelWorkload('u-cm');

      expect(workload.roleName).toBe('COUNTRY_MANAGER');
      expect(workload.assignedCountriesCount).toBe(1);
      expect(workload.assignedStatesCount).toBe(1);
      expect(workload.assignedRegionsCount).toBe(1);
    });
  });

  describe('OperationalStatusService', () => {
    it('should resolve personnel operational status card', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'u-mod',
        username: 'mod_user',
        status: AccountStatus.ACTIVE,
      });
      mockPrismaService.userRole.findMany.mockResolvedValue([
        {
          role: { name: 'MODERATOR', displayName: 'Moderator' },
          roleScopes: [
            {
              scopeType: ScopeType.REGION,
              region: { id: 'r-1', name: 'Bengaluru' },
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const status = await statusService.getOperationalStatus('u-mod');

      expect(status.roleName).toBe('MODERATOR');
      expect(status.isOperationalActive).toBe(true);
    });
  });
});
