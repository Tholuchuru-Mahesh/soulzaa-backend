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
   */
  createWithProfile(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data });
      await tx.userProfile.create({ data: { userId: user.id } });
      await tx.userStatistics.create({ data: { userId: user.id } });
      await tx.userVerification.create({ data: { userId: user.id } });
      return user;
    });
  }

  update(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }
}
