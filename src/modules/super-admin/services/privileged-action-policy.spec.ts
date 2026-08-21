import { ForbiddenException } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
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
import { AccountLifecycleService } from './account-lifecycle.service';
import { RoleAssignmentService } from './role-assignment.service';

/**
 * Rank protection across privileged Super Admin operations. The policy engine is
 * the real one — mocking it would assert on the mock rather than on whether an
 * ADMIN can actually reach a SUPER_ADMIN.
 */
describe('Super Admin privileged actions are rank-guarded', () => {
  const buildPolicyEngine = () => {
    const engine = new PolicyEngineService(new RoleRankPolicyRule());
    engine.onModuleInit();
    return engine;
  };

  /** Roles as the RBAC store would resolve them, by user id. */
  const rolesByUser: Record<string, string[]> = {
    'super-admin-1': ['SUPER_ADMIN'],
    'admin-1': ['ADMIN'],
    'moderator-1': ['MODERATOR'],
    'plain-user': ['USER'],
  };

  const roleResolver = {
    getRoleNames: jest.fn((userId: string) => Promise.resolve(rolesByUser[userId] ?? [])),
    hasRole: jest.fn((userId: string, role: string) =>
      Promise.resolve((rolesByUser[userId] ?? []).includes(role)),
    ),
  };

  describe('AccountLifecycleService', () => {
    let service: AccountLifecycleService;
    const prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
    };
    const cache = { del: jest.fn() };
    const authCache = { invalidateUser: jest.fn() };

    beforeEach(() => {
      jest.clearAllMocks();
      prisma.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve({
          id: where.id,
          username: where.id,
          status: AccountStatus.ACTIVE,
        }),
      );
      prisma.user.update.mockResolvedValue({ status: AccountStatus.SUSPENDED });

      service = new AccountLifecycleService(
        prisma as unknown as PrismaService,
        cache as unknown as CacheService,
        authCache as unknown as AuthorizationCacheService,
        roleResolver as unknown as RoleResolver,
        buildPolicyEngine(),
      );
    });

    it('stops an ADMIN from suspending a SUPER_ADMIN', async () => {
      await expect(
        service.suspendAccount('super-admin-1', { reason: 'coup' }, 'admin-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('stops an ADMIN from locking a SUPER_ADMIN', async () => {
      await expect(
        service.lockAccount('super-admin-1', { reason: 'coup' }, 'admin-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('stops an ADMIN from force-logging-out a SUPER_ADMIN', async () => {
      await expect(service.forceLogout('super-admin-1', 'admin-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('stops an ADMIN from suspending a peer ADMIN', async () => {
      rolesByUser['admin-2'] = ['ADMIN'];
      await expect(
        service.suspendAccount('admin-2', { reason: 'rivalry' }, 'admin-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('still lets an ADMIN suspend a MODERATOR', async () => {
      const res = await service.suspendAccount('moderator-1', { reason: 'abuse' }, 'admin-1');
      expect(res.newStatus).toBe(AccountStatus.SUSPENDED);
    });

    it('still lets a SUPER_ADMIN suspend an ADMIN', async () => {
      const res = await service.suspendAccount('admin-1', { reason: 'abuse' }, 'super-admin-1');
      expect(res.newStatus).toBe(AccountStatus.SUSPENDED);
    });
  });

  describe('RoleAssignmentService', () => {
    let service: RoleAssignmentService;
    const prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      role: { findFirst: jest.fn() },
      userRole: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      roleScope: { findFirst: jest.fn() },
    };
    const roleService = {
      assignRoleToUser: jest.fn(),
      assignRoleScope: jest.fn(),
      removeRoleFromUser: jest.fn(),
    };
    const authCache = { invalidateUser: jest.fn() };

    const roleRow = (name: string) => ({ id: `r-${name.toLowerCase()}`, name });

    beforeEach(() => {
      jest.clearAllMocks();
      prisma.user.findUnique.mockResolvedValue({ id: 'plain-user', username: 'target' });
      prisma.userRole.findUnique.mockResolvedValue({ id: 'ur-1' });
      roleService.assignRoleToUser.mockResolvedValue({ id: 'ur-1' });

      service = new RoleAssignmentService(
        prisma as unknown as PrismaService,
        roleService as unknown as RoleService,
        {} as CountryService,
        {} as StateService,
        {} as RegionService,
        authCache as unknown as AuthorizationCacheService,
        roleResolver as unknown as RoleResolver,
        buildPolicyEngine(),
      );
    });

    it('stops an ADMIN from granting SUPER_ADMIN', async () => {
      prisma.role.findFirst.mockResolvedValue(roleRow('SUPER_ADMIN'));
      prisma.userRole.findUnique.mockResolvedValue(null);

      await expect(
        service.assignRole('plain-user', { role: 'SUPER_ADMIN' }, 'admin-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(roleService.assignRoleToUser).not.toHaveBeenCalled();
    });

    it('stops an ADMIN from stripping a role off a SUPER_ADMIN', async () => {
      prisma.role.findFirst.mockResolvedValue(roleRow('MODERATOR'));

      await expect(service.removeRole('super-admin-1', 'MODERATOR', 'admin-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(roleService.removeRoleFromUser).not.toHaveBeenCalled();
    });

    it('still lets a SUPER_ADMIN grant SUPER_ADMIN', async () => {
      prisma.role.findFirst.mockResolvedValue(roleRow('SUPER_ADMIN'));
      prisma.userRole.findUnique.mockResolvedValue(null);

      const res = await service.assignRole('plain-user', { role: 'SUPER_ADMIN' }, 'super-admin-1');
      expect(res.roleName).toBe('SUPER_ADMIN');
    });

    it('still lets an ADMIN grant MODERATOR to a plain user', async () => {
      prisma.role.findFirst.mockResolvedValue(roleRow('MODERATOR'));
      prisma.userRole.findUnique.mockResolvedValue(null);

      const res = await service.assignRole('plain-user', { role: 'MODERATOR' }, 'admin-1');
      expect(res.roleName).toBe('MODERATOR');
    });
  });
});
