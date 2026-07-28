import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RbacSeederService } from './rbac-seeder.service';

/**
 * Roles live in two places: the legacy `User.roles` enum column and the RBAC
 * `UserRole` table. Guards read only the table, so an account whose roles were
 * never migrated is already treated as unprivileged. This backfill closes that
 * gap so the column can be retired.
 *
 * It is additive by design — it never deletes an assignment, so running it twice
 * (or after roles have been curated through Super Admin) cannot revoke anything.
 */
describe('RbacSeederService.backfillLegacyUserRoles', () => {
  let service: RbacSeederService;

  const ROLE_ROWS = [
    { id: 'r-admin', name: 'ADMIN' },
    { id: 'r-host', name: 'HOST' },
    { id: 'r-user', name: 'USER' },
  ];

  const prisma = {
    role: { findMany: jest.fn() },
    user: { findMany: jest.fn() },
    userRole: { findMany: jest.fn(), createMany: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.role.findMany.mockResolvedValue(ROLE_ROWS);
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.userRole.createMany.mockResolvedValue({ count: 0 });
    service = new RbacSeederService(prisma as unknown as PrismaService);
  });

  const created = () => prisma.userRole.createMany.mock.calls[0]?.[0]?.data ?? [];

  it('creates an assignment for each legacy role a user holds', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u-1', roles: ['ADMIN', 'HOST'] }]);

    await service.backfillLegacyUserRoles();

    expect(created()).toEqual(
      expect.arrayContaining([
        { userId: 'u-1', roleId: 'r-admin' },
        { userId: 'u-1', roleId: 'r-host' },
      ]),
    );
  });

  it('skips roles the user already has assigned', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u-1', roles: ['ADMIN', 'HOST'] }]);
    prisma.userRole.findMany.mockResolvedValue([{ userId: 'u-1', roleId: 'r-admin' }]);

    await service.backfillLegacyUserRoles();

    expect(created()).toEqual([{ userId: 'u-1', roleId: 'r-host' }]);
  });

  it('ignores legacy names that have no seeded role', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u-1', roles: ['ADMIN', 'GHOST_ROLE'] }]);

    await service.backfillLegacyUserRoles();

    expect(created()).toEqual([{ userId: 'u-1', roleId: 'r-admin' }]);
  });

  it('writes nothing when every legacy role is already assigned', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u-1', roles: ['ADMIN'] }]);
    prisma.userRole.findMany.mockResolvedValue([{ userId: 'u-1', roleId: 'r-admin' }]);

    await service.backfillLegacyUserRoles();

    expect(prisma.userRole.createMany).not.toHaveBeenCalled();
  });

  it('never deletes an existing assignment', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u-1', roles: [] }]);

    await service.backfillLegacyUserRoles();

    expect(prisma.userRole).not.toHaveProperty('deleteMany.mock.calls.0');
  });

  it('reports how many assignments it created', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u-1', roles: ['ADMIN'] }]);

    await expect(service.backfillLegacyUserRoles()).resolves.toEqual({ created: 1, scanned: 1 });
  });
});
