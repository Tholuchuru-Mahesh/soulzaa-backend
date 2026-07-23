import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RoleService } from 'src/modules/authorization/services/role.service';
import { CountryService } from 'src/modules/organization/services/country.service';
import { OrganizationHierarchyService } from 'src/modules/organization/services/organization-hierarchy.service';
import { RegionService } from 'src/modules/organization/services/region.service';
import { StateService } from 'src/modules/organization/services/state.service';
import { CountryManagerAssignmentService } from './country-manager-assignment.service';

describe('Super Admin Organization Services', () => {
  let countryService: CountryService;
  let stateService: StateService;
  let regionService: RegionService;
  let hierarchyService: OrganizationHierarchyService;
  let managerService: CountryManagerAssignmentService;

  const mockPrismaService = {
    country: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    state: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    region: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    role: {
      findUnique: jest.fn(),
    },
    userRole: {
      findUnique: jest.fn(),
    },
    roleScope: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  const mockRoleService = {
    assignRoleToUser: jest.fn(),
    assignRoleScope: jest.fn(),
    removeRoleFromUser: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CountryService,
        StateService,
        RegionService,
        OrganizationHierarchyService,
        CountryManagerAssignmentService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RoleService, useValue: mockRoleService },
      ],
    }).compile();

    countryService = module.get<CountryService>(CountryService);
    stateService = module.get<StateService>(StateService);
    regionService = module.get<RegionService>(RegionService);
    hierarchyService = module.get<OrganizationHierarchyService>(OrganizationHierarchyService);
    managerService = module.get<CountryManagerAssignmentService>(CountryManagerAssignmentService);

    jest.clearAllMocks();
  });

  describe('CountryService', () => {
    it('should create a country successfully', async () => {
      mockPrismaService.country.findUnique.mockResolvedValue(null);
      mockPrismaService.country.findFirst.mockResolvedValue(null);
      mockPrismaService.country.create.mockResolvedValue({
        id: 'c-1',
        code: 'IN',
        name: 'India',
        isActive: true,
      });

      const res = await countryService.createCountry({ code: 'IN', name: 'India' });
      expect(res.code).toBe('IN');
      expect(mockPrismaService.country.create).toHaveBeenCalled();
    });

    it('should throw ConflictException on duplicate country code', async () => {
      mockPrismaService.country.findUnique.mockResolvedValue({ id: 'c-1', code: 'IN' });

      await expect(countryService.createCountry({ code: 'IN', name: 'India' })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('StateService', () => {
    it('should throw BadRequestException if parent country is inactive', async () => {
      mockPrismaService.country.findUnique.mockResolvedValue({
        id: 'c-1',
        name: 'India',
        isActive: false,
      });

      await expect(
        stateService.createState({ countryId: 'c-1', code: 'KA', name: 'Karnataka' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('RegionService', () => {
    it('should throw NotFoundException if parent state does not exist', async () => {
      mockPrismaService.state.findUnique.mockResolvedValue(null);

      await expect(
        regionService.createRegion({ stateId: 's-99', code: 'BLR', name: 'Bengaluru' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('CountryManagerAssignmentService', () => {
    it('should assign a user as Country Manager', async () => {
      mockPrismaService.country.findUnique.mockResolvedValue({
        id: 'c-1',
        name: 'India',
        isActive: true,
      });
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u-1', username: 'cm_user' });
      mockPrismaService.role.findUnique.mockResolvedValue({ id: 'r-cm', name: 'COUNTRY_MANAGER' });
      mockRoleService.assignRoleToUser.mockResolvedValue({
        id: 'ur-1',
        userId: 'u-1',
        roleId: 'r-cm',
      });
      mockPrismaService.roleScope.findFirst.mockResolvedValue(null);

      const res = await managerService.assignCountryManager('c-1', 'u-1');

      expect(res.userId).toBe('u-1');
      expect(res.countryId).toBe('c-1');
      expect(mockRoleService.assignRoleToUser).toHaveBeenCalledWith(
        { userId: 'u-1', roleId: 'r-cm' },
        undefined,
      );
      expect(mockRoleService.assignRoleScope).toHaveBeenCalled();
    });
  });
});
