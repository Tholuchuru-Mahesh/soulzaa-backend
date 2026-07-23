import { Test, TestingModule } from '@nestjs/testing';
import { ScopeType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationCacheService } from './authorization-cache.service';
import { AuthorizationService } from './authorization.service';
import { GeographicScopeResolver } from './geographic-scope-resolver.service';
import { PermissionResolver } from './permission-resolver.service';
import { RoleResolver } from './role-resolver.service';

describe('Authorization Engine Services', () => {
  let authorizationService: AuthorizationService;
  let permissionResolver: PermissionResolver;
  let roleResolver: RoleResolver;
  let scopeResolver: GeographicScopeResolver;

  const mockPrismaService = {
    userRole: {
      findMany: jest.fn(),
    },
    roleHierarchy: {
      findMany: jest.fn(),
    },
    rolePermission: {
      findMany: jest.fn(),
    },
    permission: {
      findMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  };

  const mockAuthorizationCacheService = {
    getCachedPermissions: jest.fn().mockResolvedValue(null),
    setCachedPermissions: jest.fn().mockResolvedValue(undefined),
    getCachedRoles: jest.fn().mockResolvedValue(null),
    setCachedRoles: jest.fn().mockResolvedValue(undefined),
    getCachedScopes: jest.fn().mockResolvedValue(null),
    setCachedScopes: jest.fn().mockResolvedValue(undefined),
    invalidateUser: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthorizationService,
        PermissionResolver,
        RoleResolver,
        GeographicScopeResolver,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AuthorizationCacheService, useValue: mockAuthorizationCacheService },
      ],
    }).compile();

    authorizationService = module.get<AuthorizationService>(AuthorizationService);
    permissionResolver = module.get<PermissionResolver>(PermissionResolver);
    roleResolver = module.get<RoleResolver>(RoleResolver);
    scopeResolver = module.get<GeographicScopeResolver>(GeographicScopeResolver);

    jest.clearAllMocks();
  });

  describe('RoleResolver & Hierarchy', () => {
    it('should resolve direct and inherited child roles via hierarchy', async () => {
      mockPrismaService.userRole.findMany.mockResolvedValue([
        {
          userId: 'user-1',
          role: { id: 'role-admin', name: 'ADMIN' },
        },
      ]);

      mockPrismaService.roleHierarchy.findMany.mockResolvedValue([
        {
          parentRoleId: 'role-admin',
          childRoleId: 'role-cm',
          parentRole: { id: 'role-admin', name: 'ADMIN' },
          childRole: { id: 'role-cm', name: 'COUNTRY_MANAGER' },
        },
      ]);

      const roles = await roleResolver.resolveAllUserRoles('user-1');

      expect(roles).toHaveLength(2);
      expect(roles.map((r) => r.roleName)).toContain('ADMIN');
      expect(roles.map((r) => r.roleName)).toContain('COUNTRY_MANAGER');
    });
  });

  describe('PermissionResolver', () => {
    it('should grant wildcard permissions to SUPER_ADMIN', async () => {
      mockPrismaService.userRole.findMany.mockResolvedValue([
        {
          userId: 'super-admin-user',
          role: { id: 'role-sa', name: 'SUPER_ADMIN' },
        },
      ]);
      mockPrismaService.roleHierarchy.findMany.mockResolvedValue([]);

      const hasPerm = await permissionResolver.checkUserHasPermissions('super-admin-user', [
        'wallet.adjust',
        'user.delete',
      ]);
      expect(hasPerm).toBe(true);
    });

    it('should correctly check specific permission codes', async () => {
      mockPrismaService.userRole.findMany.mockResolvedValue([
        {
          userId: 'mod-user',
          role: { id: 'role-mod', name: 'MODERATOR' },
        },
      ]);
      mockPrismaService.roleHierarchy.findMany.mockResolvedValue([]);
      mockPrismaService.rolePermission.findMany.mockResolvedValue([
        {
          roleId: 'role-mod',
          permission: { code: 'user.ban' },
        },
      ]);

      const canBan = await permissionResolver.checkUserHasPermissions('mod-user', ['user.ban']);
      const canDelete = await permissionResolver.checkUserHasPermissions('mod-user', [
        'user.delete',
      ]);

      expect(canBan).toBe(true);
      expect(canDelete).toBe(false);
    });
  });

  describe('GeographicScopeResolver', () => {
    it('should allow access if user has GLOBAL scope', async () => {
      mockPrismaService.userRole.findMany.mockResolvedValue([
        {
          id: 'ur-1',
          role: { name: 'COUNTRY_MANAGER' },
          roleScopes: [
            {
              scopeType: ScopeType.GLOBAL,
            },
          ],
        },
      ]);

      const isAllowed = await scopeResolver.isWithinScope('user-1', { countryCode: 'IN' });
      expect(isAllowed).toBe(true);
    });

    it('should match country code for COUNTRY scope', async () => {
      mockPrismaService.userRole.findMany.mockResolvedValue([
        {
          id: 'ur-1',
          role: { name: 'COUNTRY_MANAGER' },
          roleScopes: [
            {
              scopeType: ScopeType.COUNTRY,
              country: { code: 'IN' },
            },
          ],
        },
      ]);

      const allowedIndia = await scopeResolver.isWithinScope('user-1', { countryCode: 'IN' });
      const allowedUS = await scopeResolver.isWithinScope('user-1', { countryCode: 'US' });

      expect(allowedIndia).toBe(true);
      expect(allowedUS).toBe(false);
    });
  });

  describe('Effective Permissions Endpoint Service', () => {
    it('should compile effective permission profile for a user', async () => {
      mockPrismaService.userRole.findMany.mockResolvedValue([
        {
          userId: 'user-admin',
          role: { id: 'role-admin', name: 'ADMIN' },
          roleScopes: [],
        },
      ]);
      mockPrismaService.roleHierarchy.findMany.mockResolvedValue([
        {
          parentRoleId: 'role-admin',
          childRoleId: 'role-cm',
          parentRole: { id: 'role-admin', name: 'ADMIN' },
          childRole: { id: 'role-cm', name: 'COUNTRY_MANAGER' },
        },
      ]);
      mockPrismaService.rolePermission.findMany.mockResolvedValue([
        {
          roleId: 'role-admin',
          permission: { code: 'wallet.adjust', category: 'WALLET' },
        },
      ]);
      mockPrismaService.permission.findMany.mockResolvedValue([
        { code: 'wallet.adjust', category: 'WALLET' },
      ]);

      const profile = await authorizationService.getEffectivePermissions('user-admin');

      expect(profile.userId).toBe('user-admin');
      expect(profile.assignedRoles).toEqual(['ADMIN']);
      expect(profile.inheritedRoles).toEqual(['COUNTRY_MANAGER']);
      expect(profile.resolvedPermissions).toContain('wallet.adjust');
      expect(profile.permissionCategories['WALLET']).toEqual(['wallet.adjust']);
    });
  });
});
