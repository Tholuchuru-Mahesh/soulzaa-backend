import { Injectable } from '@nestjs/common';
import { Friendship } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Canonical ordering of a user pair so an undirected friendship is one row. */
export function orderPair(a: string, b: string): { userAId: string; userBId: string } {
  return a < b ? { userAId: a, userBId: b } : { userAId: b, userBId: a };
}

/**
 * Prisma access for the `friendships` table. Friendships are undirected and
 * stored as a single canonical row (userAId < userBId). Best-friend is a
 * per-direction pin: `isBestFriendA` is userA's pin of userB and vice-versa.
 */
@Injectable()
export class FriendshipRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(a: string, b: string): Promise<Friendship | null> {
    const { userAId, userBId } = orderPair(a, b);
    return this.prisma.friendship.findUnique({ where: { userAId_userBId: { userAId, userBId } } });
  }

  async exists(a: string, b: string): Promise<boolean> {
    return (await this.find(a, b)) !== null;
  }

  /** Delete the friendship between two users. Returns true if a row was removed. */
  async delete(a: string, b: string): Promise<boolean> {
    const { userAId, userBId } = orderPair(a, b);
    const res = await this.prisma.friendship.deleteMany({ where: { userAId, userBId } });
    return res.count > 0;
  }

  /** All friendship rows involving `userId` (either side). */
  allForUser(userId: string): Promise<Friendship[]> {
    return this.prisma.friendship.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
    });
  }

  countForUser(userId: string): Promise<number> {
    return this.prisma.friendship.count({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
    });
  }

  /** Ids of everyone `userId` is friends with. */
  async friendIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.friendship.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      select: { userAId: true, userBId: true },
    });
    return rows.map((r) => (r.userAId === userId ? r.userBId : r.userAId));
  }

  /** Accrue interaction score onto the canonical friendship (no-op if absent). */
  async bumpInteraction(a: string, b: string, delta: number): Promise<void> {
    const { userAId, userBId } = orderPair(a, b);
    await this.prisma.friendship.updateMany({
      where: { userAId, userBId },
      data: { interactionScore: { increment: delta }, lastInteractionAt: new Date() },
    });
  }

  /** Set/unset `userId`'s best-friend pin on the friendship with `friendId`. */
  async setBestFriend(userId: string, friendId: string, best: boolean): Promise<Friendship | null> {
    const { userAId, userBId } = orderPair(userId, friendId);
    const data = userId === userAId ? { isBestFriendA: best } : { isBestFriendB: best };
    const res = await this.prisma.friendship.updateMany({
      where: { userAId, userBId },
      data,
    });
    if (res.count === 0) return null;
    return this.prisma.friendship.findUnique({ where: { userAId_userBId: { userAId, userBId } } });
  }
}
