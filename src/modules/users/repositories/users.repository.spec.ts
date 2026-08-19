import { UsersRepository } from './users.repository';

/**
 * A user created without a `user_roles` row authenticates normally and then
 * fails every permission-gated route with a 403 — gifting, families, VIP,
 * withdrawals, role requests. The failure is invisible until someone reports it,
 * so the assignment is pinned here rather than left to a caller to remember.
 */
describe('UsersRepository.createWithProfile', () => {
  const createdUser = { id: 'u1', roles: ['USER'] };

  function prismaWith(roleRows: Array<{ id: string }>) {
    const tx = {
      user: { create: jest.fn().mockResolvedValue(createdUser) },
      userProfile: { create: jest.fn() },
      userStatistics: { create: jest.fn() },
      userVerification: { create: jest.fn() },
      role: { findMany: jest.fn().mockResolvedValue(roleRows) },
      userRole: { createMany: jest.fn() },
    };
    return {
      tx,
      prisma: { $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)) },
    };
  }

  it('writes the RBAC assignment alongside the profile aggregate', async () => {
    const { tx, prisma } = prismaWith([{ id: 'role-user' }]);

    await new UsersRepository(prisma as never).createWithProfile({ username: 'a' } as never);

    expect(tx.userRole.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'u1', roleId: 'role-user' }],
      skipDuplicates: true,
    });
  });

  it('resolves roles from the stored row, not the caller input', async () => {
    // `roles` has a database default, so an ordinary signup passes no roles at
    // all and the stored value is ['USER']. Reading the input would assign none.
    const { tx, prisma } = prismaWith([{ id: 'role-user' }]);

    await new UsersRepository(prisma as never).createWithProfile({ username: 'a' } as never);

    expect(tx.role.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: { in: ['USER'] } } }),
    );
  });

  it('still creates the account when RBAC roles are not seeded yet', async () => {
    // A fresh database can reach registration before the seeder has run. Losing
    // the assignment is recoverable (bootstrap backfills it); refusing to create
    // the account is not.
    const { tx, prisma } = prismaWith([]);

    await expect(
      new UsersRepository(prisma as never).createWithProfile({ username: 'a' } as never),
    ).resolves.toEqual(createdUser);
    expect(tx.userRole.createMany).not.toHaveBeenCalled();
  });

  it('creates the profile, statistics and verification rows in the same transaction', async () => {
    const { tx, prisma } = prismaWith([{ id: 'role-user' }]);

    await new UsersRepository(prisma as never).createWithProfile({ username: 'a' } as never);

    expect(tx.userProfile.create).toHaveBeenCalledWith({
      data: { userId: 'u1', city: null, state: null },
    });
    expect(tx.userStatistics.create).toHaveBeenCalledWith({ data: { userId: 'u1' } });
    expect(tx.userVerification.create).toHaveBeenCalledWith({ data: { userId: 'u1' } });
  });
});
