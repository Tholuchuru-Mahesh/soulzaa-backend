import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationCacheService } from './authorization-cache.service';
import { RoleResolver } from './role-resolver.service';

/**
 * `getRoleNames` expands the hierarchy, so an ADMIN reads as an OFFICIAL. The
 * direct reader answers the other question — what was actually granted to this
 * account — which is what identity projections (badges, staff flags) need.
 *
 * Fixture hierarchy: ADMIN → COUNTRY_MANAGER → OFFICIAL → MODERATOR
 */
describe('RoleResolver.getDirectRoleNames', () => {
  const mockPrisma = { userRole: { findMany: jest.fn() } };
  const mockCache = { getCachedRoles: jest.fn(), setCachedRoles: jest.fn() };
  let resolver: RoleResolver;

  beforeEach(() => {
    jest.clearAllMocks();
    resolver = new RoleResolver(
      mockPrisma as unknown as PrismaService,
      mockCache as unknown as AuthorizationCacheService,
    );
  });

  it('returns only the roles assigned to the account', async () => {
    mockPrisma.userRole.findMany.mockResolvedValue([
      { role: { id: 'r-official', name: 'OFFICIAL' } },
      { role: { id: 'r-user', name: 'USER' } },
    ]);

    await expect(resolver.getDirectRoleNames('u-1')).resolves.toEqual(['OFFICIAL', 'USER']);
  });

  it('excludes a suspended assignment', async () => {
    mockPrisma.userRole.findMany.mockResolvedValue([]);

    await expect(resolver.getDirectRoleNames('u-1')).resolves.toEqual([]);
    expect(mockPrisma.userRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u-1', suspendedAt: null } }),
    );
  });
});
