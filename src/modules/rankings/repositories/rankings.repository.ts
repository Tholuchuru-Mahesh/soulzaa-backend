import { Inject, Injectable } from '@nestjs/common';
import { Prisma, RankingSnapshot } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';

export interface RedisRankedEntry {
  member: string;
  score: number;
}

@Injectable()
export class RankingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly client: RedisClient,
  ) {}

  // ---- Redis Real-time Rankings Operations ----

  async incrementScore(key: string, member: string, delta: number): Promise<number> {
    const value = await this.client.zincrby(key, delta, member);
    return Number(value);
  }

  async getTopFromRedis(key: string, limit: number): Promise<RedisRankedEntry[]> {
    const flat = await this.client.zrevrange(key, 0, limit - 1, 'WITHSCORES');
    const entries: RedisRankedEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      entries.push({ member: flat[i], score: Number(flat[i + 1]) });
    }
    return entries;
  }

  async getRangeFromRedis(key: string, start: number, stop: number): Promise<RedisRankedEntry[]> {
    const flat = await this.client.zrevrange(key, start, stop, 'WITHSCORES');
    const entries: RedisRankedEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      entries.push({ member: flat[i], score: Number(flat[i + 1]) });
    }
    return entries;
  }

  async getCountFromRedis(key: string): Promise<number> {
    return this.client.zcard(key);
  }

  async getRankFromRedis(key: string, member: string): Promise<number | null> {
    const r = await this.client.zrevrank(key, member);
    return r === null ? null : r;
  }

  async getScoreFromRedis(key: string, member: string): Promise<number | null> {
    const s = await this.client.zscore(key, member);
    return s === null ? null : Number(s);
  }

  async setKeyTtl(key: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(key, ttlSeconds);
  }

  // ---- PostgreSQL Fallback Aggregations ----

  async getGiftersFromDb(
    sinceDate: Date | null,
    skip: number,
    take: number,
  ): Promise<[RedisRankedEntry[], number]> {
    const where: Prisma.GiftTransactionWhereInput = {
      status: 'COMPLETED',
      ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
    };
    const grouped = await this.prisma.giftTransaction.groupBy({
      by: ['senderId'],
      where,
      _sum: { totalCoinValue: true },
      orderBy: { _sum: { totalCoinValue: 'desc' } },
      skip,
      take,
    });
    if (grouped.length > 0) {
      const count = await this.prisma.giftTransaction
        .groupBy({ by: ['senderId'], where })
        .then((r) => r.length);
      return [
        grouped.map((g) => ({ member: g.senderId, score: Number(g._sum.totalCoinValue ?? 0) })),
        count,
      ];
    }
    // Fallback: active users with giftsSent
    const stats = await this.prisma.userStatistics.findMany({
      where: { giftsSent: { gt: 0 } },
      orderBy: { giftsSent: 'desc' },
      skip,
      take,
    });
    const count = await this.prisma.userStatistics.count({
      where: { giftsSent: { gt: 0 } },
    });
    return [stats.map((s) => ({ member: s.userId, score: Number(s.giftsSent) })), count];
  }

  async getReceiversFromDb(
    sinceDate: Date | null,
    skip: number,
    take: number,
  ): Promise<[RedisRankedEntry[], number]> {
    const where: Prisma.GiftTransactionWhereInput = {
      status: 'COMPLETED',
      ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
    };
    const grouped = await this.prisma.giftTransaction.groupBy({
      by: ['receiverId'],
      where,
      _sum: { totalCoinValue: true },
      orderBy: { _sum: { totalCoinValue: 'desc' } },
      skip,
      take,
    });
    if (grouped.length > 0) {
      const count = await this.prisma.giftTransaction
        .groupBy({ by: ['receiverId'], where })
        .then((r) => r.length);
      return [
        grouped.map((g) => ({ member: g.receiverId, score: Number(g._sum.totalCoinValue ?? 0) })),
        count,
      ];
    }
    // Fallback: active users with coinsReceived
    const stats = await this.prisma.userStatistics.findMany({
      where: { coinsReceived: { gt: 0 } },
      orderBy: { coinsReceived: 'desc' },
      skip,
      take,
    });
    const count = await this.prisma.userStatistics.count({
      where: { coinsReceived: { gt: 0 } },
    });
    return [stats.map((s) => ({ member: s.userId, score: Number(s.coinsReceived) })), count];
  }

  async getStreamersFromDb(
    sinceDate: Date | null,
    skip: number,
    take: number,
  ): Promise<[RedisRankedEntry[], number]> {
    const where: Prisma.GiftTransactionWhereInput = {
      status: 'COMPLETED',
      contextType: { in: ['AUDIO_ROOM', 'VIDEO_ROOM', 'LIVE_STREAM'] },
      ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
    };
    const grouped = await this.prisma.giftTransaction.groupBy({
      by: ['receiverId'],
      where,
      _sum: { totalCoinValue: true },
      orderBy: { _sum: { totalCoinValue: 'desc' } },
      skip,
      take,
    });
    if (grouped.length > 0) {
      const count = await this.prisma.giftTransaction
        .groupBy({ by: ['receiverId'], where })
        .then((r) => r.length);
      return [
        grouped.map((g) => ({ member: g.receiverId, score: Number(g._sum.totalCoinValue ?? 0) })),
        count,
      ];
    }
    // Fallback: room owners
    const rooms = await this.prisma.audioRoom.findMany({
      select: { ownerId: true },
      distinct: ['ownerId'],
      skip,
      take,
    });
    const count = await this.prisma.audioRoom.groupBy({ by: ['ownerId'] }).then((r) => r.length);
    return [rooms.map((r, i) => ({ member: r.ownerId, score: Math.max(100 - i * 10, 10) })), count];
  }

  async getFamiliesFromDb(skip: number, take: number): Promise<[RedisRankedEntry[], number]> {
    const families = await this.prisma.family.findMany({
      orderBy: [{ level: 'desc' }, { exp: 'desc' }],
      skip,
      take,
    });
    const total = await this.prisma.family.count();
    return [families.map((f) => ({ member: f.id, score: Number(f.exp ?? f.level * 100) })), total];
  }

  // ---- PostgreSQL Snapshot Operations ----

  async saveSnapshots(snapshots: Prisma.RankingSnapshotCreateManyInput[]): Promise<void> {
    if (snapshots.length === 0) return;
    await this.prisma.rankingSnapshot.createMany({
      data: snapshots,
      skipDuplicates: true,
    });
  }

  async getSnapshots(
    type: string,
    period: string,
    dateKey: string,
    skip: number,
    take: number,
  ): Promise<[RankingSnapshot[], number]> {
    const where = { type, period, dateKey };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.rankingSnapshot.findMany({
        where,
        skip,
        take,
        orderBy: { rank: 'asc' },
      }),
      this.prisma.rankingSnapshot.count({ where }),
    ]);
    return [rows, total];
  }

  // ---- Entity Detail Resolution (for formatting responses) ----

  async getUsersDetails(userIds: string[]) {
    if (userIds.length === 0) return [];
    return this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        username: true,
        fullName: true,
        isHiddenAccount: true,
      },
    });
  }

  async getUserProfilesAndStats(userIds: string[]) {
    if (userIds.length === 0) return { profiles: [], statistics: [] };
    const [profiles, statistics] = await this.prisma.$transaction([
      this.prisma.userProfile.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, avatarKey: true },
      }),
      this.prisma.userStatistics.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, level: true, vipLevel: true },
      }),
    ]);
    return { profiles, statistics };
  }

  async getFamiliesDetails(familyIds: string[]) {
    if (familyIds.length === 0) return [];
    const families = await this.prisma.family.findMany({
      where: { id: { in: familyIds } },
      select: {
        id: true,
        name: true,
        logo: true,
        level: true,
        founderId: true,
      },
    });

    const founderIds = families.map((f) => f.founderId);
    const leaders = await this.prisma.user.findMany({
      where: { id: { in: founderIds } },
      select: { id: true, username: true },
    });

    return families.map((family) => {
      const leader = leaders.find((l) => l.id === family.founderId);
      return {
        ...family,
        leaderUsername: leader ? leader.username : 'Unknown',
      };
    });
  }
}
