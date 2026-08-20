import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationCacheService } from 'src/modules/authorization/services/authorization-cache.service';
import {
  PolicyEngineService,
  RoleRankPolicyRule,
} from 'src/modules/authorization/services/policy-engine.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { RoleService } from 'src/modules/authorization/services/role.service';
import { CountryService } from 'src/modules/organization/services/country.service';
import { RegionService } from 'src/modules/organization/services/region.service';
import { StateService } from 'src/modules/organization/services/state.service';
import { RoleAssignmentService } from './role-assignment.service';

/**
 * An account gets one assignable role. The single exception is Coin Seller,
 * which is activated inside an existing Agency account rather than replacing it.
 *
 * USER (granted at signup), HOST and CREATOR (earned, not appointed) are not
 * assignments and must never block one.
 */
describe('RoleAssignmentService — one assignable role per account', () => {
  let service: RoleAssignmentService;

  const mockPrisma = {
    user: { findUnique: jest.fn() },
    role: { findFirst: jest.fn() },
    userRole: { findUnique: jest.fn(), findMany: jest.fn() },
    roleScope: { findFirst: jest.fn() },
  };
  const mockRoleService = {
    assignRoleToUser: jest.fn(),
    assignRoleScope: jest.fn(),
    removeRoleFromUser: jest.fn(),
  };
  const mockRoleResolver = { hasRole: jest.fn(), getRoleNames: jest.fn() };
  const mockAuthCache = { invalidateUser: jest.fn() };

  /** What the account already holds, as user_roles rows. */
  const holding = (...names: string[]) =>
    mockPrisma.userRole.findMany.mockResolvedValue(
      names.map((name) => ({ role: { id: `r-${name}`, name } })),
    );

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoleAssignmentService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RoleService, useValue: mockRoleService },
        { provide: CountryService, useValue: { getCountryById: jest.fn() } },
        { provide: StateService, useValue: { getStateById: jest.fn() } },
        { provide: RegionService, useValue: { getRegionById: jest.fn() } },
        { provide: AuthorizationCacheService, useValue: mockAuthCache },
        { provide: RoleResolver, useValue: mockRoleResolver },
        PolicyEngineService,
        RoleRankPolicyRule,
      ],
    }).compile();

    service = module.get(RoleAssignmentService);
    module.get(PolicyEngineService).onModuleInit();
    jest.clearAllMocks();

    mockRoleResolver.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
    mockRoleResolver.hasRole.mockResolvedValue(true);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', username: 'nasinasujatha4' });
    mockPrisma.userRole.findUnique.mockResolvedValue(null);
    mockRoleService.assignRoleToUser.mockResolvedValue({ id: 'ur-1' });
    holding('USER');
  });

  const assign = (role: string) => service.assignRole('u-1', { role }, 'actor-1');

  it('refuses a second assignable role', async () => {
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-official', name: 'OFFICIAL' });
    holding('USER', 'AGENCY');

    await expect(assign('OFFICIAL')).rejects.toThrow(ConflictException);
    expect(mockRoleService.assignRoleToUser).not.toHaveBeenCalled();
  });

  it('names the role the account already holds', async () => {
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-official', name: 'OFFICIAL' });
    holding('USER', 'AGENCY', 'COIN_SELLER');

    await expect(assign('OFFICIAL')).rejects.toThrow(/AGENCY, COIN_SELLER/);
  });

  it('allows Coin Seller on top of Agency', async () => {
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-cs', name: 'COIN_SELLER' });
    holding('USER', 'AGENCY');

    await expect(assign('COIN_SELLER')).resolves.toMatchObject({ roleName: 'COIN_SELLER' });
  });

  it('allows Agency on top of Coin Seller', async () => {
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-agency', name: 'AGENCY' });
    holding('USER', 'COIN_SELLER');

    await expect(assign('AGENCY')).resolves.toMatchObject({ roleName: 'AGENCY' });
  });

  it('allows the first assignable role on a plain account', async () => {
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-official', name: 'OFFICIAL' });
    holding('USER');

    await expect(assign('OFFICIAL')).resolves.toMatchObject({ roleName: 'OFFICIAL' });
  });

  it('does not count HOST or CREATOR as an assignment', async () => {
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-agency', name: 'AGENCY' });
    holding('USER', 'HOST', 'CREATOR');

    await expect(assign('AGENCY')).resolves.toMatchObject({ roleName: 'AGENCY' });
  });

  it('reads what the account holds rather than trusting the hierarchy', async () => {
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-official', name: 'OFFICIAL' });
    holding('USER');
    // The resolver would report the whole inherited set; only direct rows count.
    mockRoleResolver.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);

    await expect(assign('OFFICIAL')).resolves.toMatchObject({ roleName: 'OFFICIAL' });
    expect(mockPrisma.userRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'u-1' }) }),
    );
  });
});
