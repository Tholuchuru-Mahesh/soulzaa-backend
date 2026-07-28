import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationCacheService } from './authorization-cache.service';
import { RoleService } from './role.service';

/**
 * A hierarchy edge changes what every ancestor role inherits, so the cached role
 * and permission sets of everyone holding those roles go stale the moment an edge
 * is added or removed. Without invalidation they survive until the TTL expires.
 *
 * Fixture hierarchy: ADMIN → COUNTRY_MANAGER → OFFICIAL → MODERATOR
 */
describe('RoleService — role hierarchy edits invalidate affected users', () => {
  let service: RoleService;

  const EDGES = [
    { parentRoleId: 'r-admin', childRoleId: 'r-cm' },
    { parentRoleId: 'r-cm', childRoleId: 'r-official' },
    { parentRoleId: 'r-official', childRoleId: 'r-moderator' },
  ];

  const mockPrisma = {
    roleHierarchy: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
    userRole: { findMany: jest.fn() },
  };
  const mockCache = { invalidateUser: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.roleHierarchy.findMany.mockResolvedValue(EDGES);
    mockPrisma.roleHierarchy.upsert.mockResolvedValue({ id: 'edge-1' });
    mockPrisma.roleHierarchy.deleteMany.mockResolvedValue({ count: 1 });
    service = new RoleService(
      mockPrisma as unknown as PrismaService,
      mockCache as unknown as AuthorizationCacheService,
    );
  });

  it('invalidates holders of the parent role when an edge is added', async () => {
    mockPrisma.userRole.findMany.mockResolvedValue([{ userId: 'official-1' }]);

    await service.addRoleHierarchyEdge({ parentRoleId: 'r-official', childRoleId: 'r-host' });

    expect(mockCache.invalidateUser).toHaveBeenCalledWith('official-1');
  });

  it('invalidates holders of ancestor roles, which inherit through the new edge', async () => {
    mockPrisma.userRole.findMany.mockResolvedValue([]);

    await service.addRoleHierarchyEdge({ parentRoleId: 'r-official', childRoleId: 'r-host' });

    // OFFICIAL plus everything above it: COUNTRY_MANAGER and ADMIN.
    const queriedRoleIds = mockPrisma.userRole.findMany.mock.calls[0][0].where.roleId.in;
    expect(new Set(queriedRoleIds)).toEqual(new Set(['r-official', 'r-cm', 'r-admin']));
  });

  it('does not invalidate holders of unrelated descendant roles', async () => {
    mockPrisma.userRole.findMany.mockResolvedValue([]);

    await service.addRoleHierarchyEdge({ parentRoleId: 'r-official', childRoleId: 'r-host' });

    const queriedRoleIds = mockPrisma.userRole.findMany.mock.calls[0][0].where.roleId.in;
    expect(queriedRoleIds).not.toContain('r-moderator');
  });

  it('invalidates affected users when an edge is removed', async () => {
    mockPrisma.userRole.findMany.mockResolvedValue([{ userId: 'admin-1' }]);

    await service.removeRoleHierarchyEdge('r-cm', 'r-official');

    expect(mockCache.invalidateUser).toHaveBeenCalledWith('admin-1');
  });

  it('terminates when the hierarchy contains a cycle', async () => {
    mockPrisma.roleHierarchy.findMany.mockResolvedValue([
      { parentRoleId: 'r-a', childRoleId: 'r-b' },
      { parentRoleId: 'r-b', childRoleId: 'r-a' },
    ]);
    mockPrisma.userRole.findMany.mockResolvedValue([]);

    await expect(
      service.addRoleHierarchyEdge({ parentRoleId: 'r-a', childRoleId: 'r-c' }),
    ).resolves.toBeDefined();
  });
});
