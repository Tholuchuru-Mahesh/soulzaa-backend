import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CountryService } from './country.service';
import { OrganizationHierarchyService } from './organization-hierarchy.service';
import { RegionService } from './region.service';
import { StateService } from './state.service';

describe('Organization Module Shared Services', () => {
  let countryService: CountryService;
  let stateService: StateService;
  let regionService: RegionService;
  let hierarchyService: OrganizationHierarchyService;

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
      findMany: jest.fn(),
    },
    roleScope: {
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CountryService,
        StateService,
        RegionService,
        OrganizationHierarchyService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    countryService = module.get<CountryService>(CountryService);
    stateService = module.get<StateService>(StateService);
    regionService = module.get<RegionService>(RegionService);
    hierarchyService = module.get<OrganizationHierarchyService>(OrganizationHierarchyService);

    jest.clearAllMocks();
  });

  describe('CountryService', () => {
    it('should create country successfully', async () => {
      mockPrismaService.country.findUnique.mockResolvedValue(null);
      mockPrismaService.country.findFirst.mockResolvedValue(null);
      mockPrismaService.country.create.mockResolvedValue({
        id: 'c-1',
        code: 'US',
        name: 'United States',
      });

      const res = await countryService.createCountry({ code: 'US', name: 'United States' });
      expect(res.code).toBe('US');
    });

    it('should throw ConflictException if country code exists', async () => {
      mockPrismaService.country.findUnique.mockResolvedValue({ id: 'c-1', code: 'US' });

      await expect(
        countryService.createCountry({ code: 'US', name: 'United States' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('StateService', () => {
    it('should throw BadRequestException if parent country is inactive', async () => {
      mockPrismaService.country.findUnique.mockResolvedValue({
        id: 'c-1',
        name: 'US',
        isActive: false,
      });

      await expect(
        stateService.createState({ countryId: 'c-1', code: 'NY', name: 'New York' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('RegionService', () => {
    it('should throw NotFoundException if state not found', async () => {
      mockPrismaService.state.findUnique.mockResolvedValue(null);

      await expect(
        regionService.createRegion({ stateId: 's-99', code: 'NYC', name: 'New York City' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('OrganizationHierarchyService', () => {
    it('should resolve full organization hierarchy graph', async () => {
      mockPrismaService.country.findMany.mockResolvedValue([
        {
          id: 'c-1',
          code: 'US',
          name: 'United States',
          isActive: true,
          states: [
            {
              id: 's-1',
              code: 'NY',
              name: 'New York',
              isActive: true,
              regions: [{ id: 'r-1', code: 'NYC', name: 'New York City', isActive: true }],
            },
          ],
        },
      ]);
      mockPrismaService.roleScope.findMany.mockResolvedValue([]);
      mockPrismaService.user.findMany.mockResolvedValue([]);

      const hierarchy = await hierarchyService.getFullHierarchy();
      expect(hierarchy.totalCountries).toBe(1);
      expect(hierarchy.totalStates).toBe(1);
      expect(hierarchy.totalRegions).toBe(1);
      expect(hierarchy.hierarchy[0].code).toBe('US');
    });
  });
});
