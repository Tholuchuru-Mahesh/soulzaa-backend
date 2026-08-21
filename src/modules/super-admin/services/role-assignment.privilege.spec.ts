import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { PERMISSIONS_KEY } from 'src/common/constants';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationController } from 'src/modules/authorization/controllers/authorization.controller';
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
 * Privilege-escalation guards on role management. The actor's authority must be
 * read from the RBAC store rather than supplied by the caller, so a stale token
 * claim (or a missing one) can never grant SUPER_ADMIN-only operations.
 */
describe('RoleAssignmentService — actor authority comes from the RBAC store', () => {
  let service: RoleAssignmentService;

  const mockPrisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    role: { findFirst: jest.fn() },
    userRole: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    roleScope: { findFirst: jest.fn() },
  };
  const mockRoleService = {
    assignRoleToUser: jest.fn(),
    assignRoleScope: jest.fn(),
    removeRoleFromUser: jest.fn(),
  };
  const mockRoleResolver = { hasRole: jest.fn(), getRoleNames: jest.fn() };
  const mockAuthCache = { invalidateUser: jest.fn() };

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

    // Rank policy is exercised in privileged-action-policy.spec.ts; here the actor
    // is a SUPER_ADMIN so it always passes, isolating the escalation checks.
    mockRoleResolver.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
  });

  it('denies assigning ADMIN when the RBAC store says the actor is not SUPER_ADMIN', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', username: 'target' });
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-admin', name: 'ADMIN' });
    mockRoleResolver.hasRole.mockResolvedValue(false);

    await expect(service.assignRole('u-1', { role: 'ADMIN' }, 'actor-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(mockRoleResolver.hasRole).toHaveBeenCalledWith('actor-1', 'SUPER_ADMIN');
    expect(mockRoleService.assignRoleToUser).not.toHaveBeenCalled();
  });

  it('denies assigning COUNTRY_MANAGER when the RBAC store says the actor is not SUPER_ADMIN', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', username: 'target' });
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-cm', name: 'COUNTRY_MANAGER' });
    mockRoleResolver.hasRole.mockResolvedValue(false);

    await expect(service.assignRole('u-1', { role: 'COUNTRY_MANAGER' }, 'actor-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(mockRoleService.assignRoleToUser).not.toHaveBeenCalled();
  });

  it('allows assigning ADMIN when the RBAC store confirms the actor is SUPER_ADMIN', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', username: 'target' });
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-admin', name: 'ADMIN' });
    mockPrisma.userRole.findUnique.mockResolvedValue(null);
    mockRoleResolver.hasRole.mockResolvedValue(true);
    mockRoleService.assignRoleToUser.mockResolvedValue({ id: 'ur-1' });

    const res = await service.assignRole('u-1', { role: 'ADMIN' }, 'actor-1');

    expect(res.roleName).toBe('ADMIN');
    expect(mockAuthCache.invalidateUser).toHaveBeenCalledWith('u-1');
  });

  it('denies removing ADMIN when the RBAC store says the actor is not SUPER_ADMIN', async () => {
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-admin', name: 'ADMIN' });
    mockRoleResolver.hasRole.mockResolvedValue(false);

    await expect(service.removeRole('u-1', 'ADMIN', 'actor-1')).rejects.toThrow(ForbiddenException);
    expect(mockRoleService.removeRoleFromUser).not.toHaveBeenCalled();
  });

  it('does not let a caller-supplied role list influence the decision', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', username: 'target' });
    mockPrisma.role.findFirst.mockResolvedValue({ id: 'r-admin', name: 'ADMIN' });
    mockRoleResolver.hasRole.mockResolvedValue(false);

    // A stale/forged claim of SUPER_ADMIN passed as an extra argument must be ignored.
    await expect(
      (service.assignRole as (...a: unknown[]) => Promise<unknown>)(
        'u-1',
        { role: 'ADMIN' },
        'actor-1',
        ['SUPER_ADMIN'],
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

/**
 * The per-user authorization reads expose who holds which roles, permissions and
 * geographic scopes. They accept an arbitrary :userId, so they must be gated on a
 * permission — `/authorization/me` is the unprivileged self-service route.
 */
describe('AuthorizationController — per-user reads are permission-gated', () => {
  const reflector = new Reflector();

  const permissionsFor = (method: keyof AuthorizationController) =>
    reflector.get<string[]>(PERMISSIONS_KEY, AuthorizationController.prototype[method]);

  it.each([['getUserRoles'], ['getUserPermissions'], ['getUserScopes']] as Array<
    [keyof AuthorizationController]
  >)('%s requires the user.view permission', (method) => {
    expect(permissionsFor(method)).toContain('user.view');
  });

  it('leaves the self-service /me route open to any authenticated user', () => {
    expect(permissionsFor('getEffectivePermissionsForMe')).toBeUndefined();
  });
});
