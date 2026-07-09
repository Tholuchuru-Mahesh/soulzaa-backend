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
        logoKey: true,
        level: true,
        leaderId: true,
      },
    });

    const leaderIds = families.map((f) => f.leaderId);
    const leaders = await this.prisma.user.findMany({
      where: { id: { in: leaderIds } },
      select: { id: true, username: true },
    });

    return families.map((family) => {
      const leader = leaders.find((l) => l.id === family.leaderId);
      return {
        ...family,
        leaderUsername: leader ? leader.username : 'Unknown',
      };
    });
  }
}
