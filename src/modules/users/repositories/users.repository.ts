import { Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Prisma access to the `users` table (and the profile-aggregate init that must
 * happen atomically with it). Owned by the users module — no other module
 * touches these tables directly. Identity business rules (uniqueness, age)
 * live in UsersService.
 */
@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  /** Lookup user by exact UUID or UUID prefix (e.g. 8-char short ID). */
  async findByIdOrPrefix(identifier: string): Promise<User | null> {
    const isFullUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      identifier,
    );
    if (isFullUuid) {
      return this.findById(identifier);
    }
    const clean = identifier.replace(/-/g, '').toLowerCase();
    if (/^[0-9a-f]{8,36}$/i.test(clean)) {
      const pattern = `${identifier.toLowerCase()}%`;
      const matches = await this.prisma.$queryRaw<User[]>`
        SELECT * FROM users
        WHERE id::text ILIKE ${pattern}
          AND "deletedAt" IS NULL
        LIMIT 1
      `;
      return matches[0] ?? null;
    }
    return null;
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email, deletedAt: null } });
  }

  findByMobile(mobile: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { mobile, deletedAt: null } });
  }

  findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { username, deletedAt: null } });
  }

  /** Batch lookup for cross-module identity resolution (e.g. games player panels). */
  findByIds(ids: string[]): Promise<User[]> {
    return this.prisma.user.findMany({ where: { id: { in: ids }, deletedAt: null } });
  }

  /**
   * Create the identity row and its default profile/statistics/verification
   * rows in a single transaction, so a user always has a complete aggregate.
   *
   * That aggregate includes the RBAC assignment. `User.roles` is the legacy
   * column and is used only for token claims; every permission check resolves
   * through `user_roles`, so an account created without a row there passes
   * authentication and then fails *every* permission-gated route with a 403 —
   * gifting, families, VIP, withdrawals, role requests. Writing it here, in the
   * same transaction, is what makes that state unrepresentable.
   */
  createWithProfile(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data });
      await tx.userProfile.create({ data: { userId: user.id } });
      await tx.userStatistics.create({ data: { userId: user.id } });
      await tx.userVerification.create({ data: { userId: user.id } });

      // Read the roles back off the created row rather than the input: the
      // column has a database default, so `data.roles` is undefined on an
      // ordinary signup while the stored value is ['USER'].
      const roles = await tx.role.findMany({
        where: { name: { in: user.roles } },
        select: { id: true },
      });
      if (roles.length > 0) {
        await tx.userRole.createMany({
          data: roles.map((role) => ({ userId: user.id, roleId: role.id })),
          skipDuplicates: true,
        });
      }

      return user;
    });
  }

  update(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }

  /** Sets the staff-visibility flag. Callers come via UsersService.setHiddenAccount. */
  async setHiddenAccount(id: string, hidden: boolean): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { isHiddenAccount: hidden } });
  }
}
