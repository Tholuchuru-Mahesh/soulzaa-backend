import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Prisma access for the `follows` table (directed follow edges). Owned by the
 * social module — no other module touches this table. Insert/delete return a
 * boolean so callers only adjust denormalised counters when a row actually
 * changed (guards double-counting on duplicate follows / repeated unfollows).
 */
@Injectable()
export class FollowRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Insert a follow edge. Returns false if the edge already existed (P2002). */
  async create(followerId: string, followingId: string): Promise<boolean> {
    try {
      await this.prisma.follow.create({ data: { followerId, followingId } });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return false;
      }
      throw e;
    }
  }

  /** Remove a follow edge. Returns true if a row was actually deleted. */
  async delete(followerId: string, followingId: string): Promise<boolean> {
    const res = await this.prisma.follow.deleteMany({ where: { followerId, followingId } });
    return res.count > 0;
  }

  async exists(followerId: string, followingId: string): Promise<boolean> {
    const row = await this.prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId } },
      select: { id: true },
    });
    return row !== null;
  }

  /** Ids of everyone who follows `userId`. */
  async followerIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.follow.findMany({
      where: { followingId: userId },
      select: { followerId: true },
    });
    return rows.map((r) => r.followerId);
  }

  /** Ids of everyone `userId` follows. */
  async followingIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.follow.findMany({
      where: { followerId: userId },
      select: { followingId: true },
    });
    return rows.map((r) => r.followingId);
  }

  countFollowers(userId: string): Promise<number> {
    return this.prisma.follow.count({ where: { followingId: userId } });
  }

  /** New followers gained by `userId` within a time window. */
  countFollowersInRange(userId: string, start: Date, end: Date): Promise<number> {
    return this.prisma.follow.count({
      where: { followingId: userId, createdAt: { gte: start, lte: end } },
    });
  }

  /** Most-followed users (by follower count), for the "popular" recommendation. */
  async topFollowed(limit: number): Promise<{ userId: string; count: number }[]> {
    const rows = await this.prisma.follow.groupBy({
      by: ['followingId'],
      _count: { followingId: true },
      orderBy: { _count: { followingId: 'desc' } },
      take: limit,
    });
    return rows.map((r) => ({ userId: r.followingId, count: r._count.followingId }));
  }

  countFollowing(userId: string): Promise<number> {
    return this.prisma.follow.count({ where: { followerId: userId } });
  }

  /** Paginated follower ids (most recent first) + total. */
  async pageFollowerIds(
    userId: string,
    skip: number,
    take: number,
  ): Promise<{ ids: string[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followingId: userId },
        select: { followerId: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.countFollowers(userId),
    ]);
    return { ids: rows.map((r) => r.followerId), total };
  }

  /** Paginated following ids (most recent first) + total. */
  async pageFollowingIds(
    userId: string,
    skip: number,
    take: number,
  ): Promise<{ ids: string[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followerId: userId },
        select: { followingId: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.countFollowing(userId),
    ]);
    return { ids: rows.map((r) => r.followingId), total };
  }
}
