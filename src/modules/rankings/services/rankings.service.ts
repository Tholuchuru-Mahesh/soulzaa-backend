import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  FAMILIES_SERVICE,
  IFamiliesService,
} from 'src/modules/families/interfaces/families.service.interface';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  RankedFamily,
  RankedGifter,
  RankedReceiver,
  RankedStreamer,
  RankingPeriod,
} from '../dto/rankings.dto';
import type { IRankingsService } from '../interfaces/rankings.service.interface';
import { RankingsRepository, RedisRankedEntry } from '../repositories/rankings.repository';
import { RankingPeriodResolver } from './ranking-period.resolver';

@Injectable()
export class RankingsService implements IRankingsService {
  private readonly logger = new Logger(RankingsService.name);

  constructor(
    private readonly repo: RankingsRepository,
    @Inject(FAMILIES_SERVICE) private readonly families: IFamiliesService,
    private readonly periods: RankingPeriodResolver,
  ) {}

  // ---- IRankingsService ----

  async getGifters(
    period: RankingPeriod,
    limit: number,
    page: number,
  ): Promise<Paginated<RankedGifter>> {
    const { key, isPast, dateKey } = this.resolveRankingKey('gifters', period);
    const start = (page - 1) * limit;
    const stop = start + limit - 1;

    let entries: RedisRankedEntry[] = [];
    let total = 0;

    if (isPast) {
      const [snapshots, count] = await this.repo.getSnapshots(
        'gifters',
        period,
        dateKey,
        start,
        limit,
      );
      entries = snapshots.map((s) => ({ member: s.targetId, score: Number(s.score) }));
      total = count;
    } else {
      entries = await this.repo.getRangeFromRedis(key, start, stop);
      total = await this.repo.getCountFromRedis(key);
    }

    if (entries.length === 0) {
      return buildPaginated([], total, page, limit);
    }

    const userIds = entries.map((e) => e.member);
    const details = await this.repo.getUsersDetails(userIds);
    const { profiles, statistics } = await this.repo.getUserProfilesAndStats(userIds);

    const formatted: RankedGifter[] = entries.map((entry, index) => {
      const detail = details.find((d) => d.id === entry.member);
      const profile = profiles.find((p) => p.userId === entry.member);
      const stat = statistics.find((s) => s.userId === entry.member);

      return {
        rank: start + index + 1,
        userId: entry.member,
        username: detail?.username ?? 'Unknown',
        fullName: detail?.fullName ?? null,
        avatarKey: profile?.avatarKey ?? null,
        score: entry.score,
        level: stat?.level ?? 1,
        vipLevel: stat?.vipLevel ?? 0,
      };
    });

    return buildPaginated(formatted, total, page, limit);
  }

  async getReceivers(
    period: RankingPeriod,
    limit: number,
    page: number,
  ): Promise<Paginated<RankedReceiver>> {
    const { key, isPast, dateKey } = this.resolveRankingKey('receivers', period);
    const start = (page - 1) * limit;
    const stop = start + limit - 1;

    let entries: RedisRankedEntry[] = [];
    let total = 0;

    if (isPast) {
      const [snapshots, count] = await this.repo.getSnapshots(
        'receivers',
        period,
        dateKey,
        start,
        limit,
      );
      entries = snapshots.map((s) => ({ member: s.targetId, score: Number(s.score) }));
      total = count;
    } else {
      entries = await this.repo.getRangeFromRedis(key, start, stop);
      total = await this.repo.getCountFromRedis(key);
    }

    if (entries.length === 0) {
      return buildPaginated([], total, page, limit);
    }

    const userIds = entries.map((e) => e.member);
    const details = await this.repo.getUsersDetails(userIds);
    const { profiles, statistics } = await this.repo.getUserProfilesAndStats(userIds);

    const formatted: RankedReceiver[] = entries.map((entry, index) => {
      const detail = details.find((d) => d.id === entry.member);
      const profile = profiles.find((p) => p.userId === entry.member);
      const stat = statistics.find((s) => s.userId === entry.member);

      return {
        rank: start + index + 1,
        userId: entry.member,
        username: detail?.username ?? 'Unknown',
        fullName: detail?.fullName ?? null,
        avatarKey: profile?.avatarKey ?? null,
        score: entry.score,
        level: stat?.level ?? 1,
        vipLevel: stat?.vipLevel ?? 0,
      };
    });

    return buildPaginated(formatted, total, page, limit);
  }

  async getFamilies(
    period: RankingPeriod,
    limit: number,
    page: number,
  ): Promise<Paginated<RankedFamily>> {
    const { key, isPast, dateKey } = this.resolveRankingKey('families', period);
    const start = (page - 1) * limit;
    const stop = start + limit - 1;

    let entries: RedisRankedEntry[] = [];
    let total = 0;

    if (isPast) {
      const [snapshots, count] = await this.repo.getSnapshots(
        'families',
        period,
        dateKey,
        start,
        limit,
      );
      entries = snapshots.map((s) => ({ member: s.targetId, score: Number(s.score) }));
      total = count;
    } else {
      entries = await this.repo.getRangeFromRedis(key, start, stop);
      total = await this.repo.getCountFromRedis(key);
    }

    if (entries.length === 0) {
      return buildPaginated([], total, page, limit);
    }

    const familyIds = entries.map((e) => e.member);
    const details = await this.repo.getFamiliesDetails(familyIds);

    const formatted: RankedFamily[] = entries.map((entry, index) => {
      const detail = details.find((d) => d.id === entry.member);

      return {
        rank: start + index + 1,
        familyId: entry.member,
        name: detail?.name ?? 'Unknown',
        logoKey: detail?.logoKey ?? null,
        score: entry.score,
        level: detail?.level ?? 1,
        leaderUsername: detail?.leaderUsername ?? 'Unknown',
      };
    });

    return buildPaginated(formatted, total, page, limit);
  }

  async getStreamers(
    period: RankingPeriod,
    limit: number,
    page: number,
  ): Promise<Paginated<RankedStreamer>> {
    const { key, isPast, dateKey } = this.resolveRankingKey('streamers', period);
    const start = (page - 1) * limit;
    const stop = start + limit - 1;

    let entries: RedisRankedEntry[] = [];
    let total = 0;

    if (isPast) {
      const [snapshots, count] = await this.repo.getSnapshots(
        'streamers',
        period,
        dateKey,
        start,
        limit,
      );
      entries = snapshots.map((s) => ({ member: s.targetId, score: Number(s.score) }));
      total = count;
    } else {
      entries = await this.repo.getRangeFromRedis(key, start, stop);
      total = await this.repo.getCountFromRedis(key);
    }

    if (entries.length === 0) {
      return buildPaginated([], total, page, limit);
    }

    const userIds = entries.map((e) => e.member);
    const details = await this.repo.getUsersDetails(userIds);
    const { profiles, statistics } = await this.repo.getUserProfilesAndStats(userIds);

    const formatted: RankedStreamer[] = entries.map((entry, index) => {
      const detail = details.find((d) => d.id === entry.member);
      const profile = profiles.find((p) => p.userId === entry.member);
      const stat = statistics.find((s) => s.userId === entry.member);

      return {
        rank: start + index + 1,
        userId: entry.member,
        username: detail?.username ?? 'Unknown',
        fullName: detail?.fullName ?? null,
        avatarKey: profile?.avatarKey ?? null,
        score: entry.score,
        level: stat?.level ?? 1,
        vipLevel: stat?.vipLevel ?? 0,
      };
    });

    return buildPaginated(formatted, total, page, limit);
  }

  // ---- Real-time event updates ----

  async updateGiftRankings(payload: {
    senderId: string;
    receiverId: string;
    totalCoinValue: number;
    contextType: string;
    contextId: string;
  }): Promise<void> {
    const date = new Date();
    const { daily, weekly, monthly } = this.getDateKeys(date);

    // 1. Increment Gifter scores
    await this.incrementAllPeriods(
      'gifters',
      payload.senderId,
      payload.totalCoinValue,
      daily,
      weekly,
      monthly,
    );

    // 2. Increment Receiver scores
    await this.incrementAllPeriods(
      'receivers',
      payload.receiverId,
      payload.totalCoinValue,
      daily,
      weekly,
      monthly,
    );

    // 3. Increment Streamer scores (only for room/streaming contexts)
    const isStreamContext =
      payload.contextType === 'AUDIO_ROOM' ||
      payload.contextType === 'VIDEO_ROOM' ||
      payload.contextType === 'LIVE_STREAM';

    if (isStreamContext) {
      await this.incrementAllPeriods(
        'streamers',
        payload.receiverId,
        payload.totalCoinValue,
        daily,
        weekly,
        monthly,
      );
    }

    // 4. Increment Family scores if sender is in a family
    const familyId = await this.families.getMemberFamilyId(payload.senderId);
    if (familyId) {
      await this.incrementAllPeriods(
        'families',
        familyId,
        payload.totalCoinValue,
        daily,
        weekly,
        monthly,
      );
      await this.families.incrementMemberContribution(payload.senderId, payload.totalCoinValue);
      await this.families.addFamilyExp(familyId, payload.totalCoinValue);
    }
  }

  // ---- Scheduler Snapshot Logic ----

  async takeMidnightSnapshots(): Promise<void> {
    this.logger.log('Taking midnight snapshots of rankings...');

    // Yesterday's date key computation
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const keysYesterday = this.getDateKeys(yesterday);
    const keysToday = this.getDateKeys(new Date());

    const isWeeklyTransition = keysYesterday.weekly !== keysToday.weekly;
    const isMonthlyTransition = keysYesterday.monthly !== keysToday.monthly;

    const periodsToSnapshot: { period: RankingPeriod; dateKey: string }[] = [
      { period: RankingPeriod.DAILY, dateKey: keysYesterday.daily },
    ];

    if (isWeeklyTransition) {
      periodsToSnapshot.push({ period: RankingPeriod.WEEKLY, dateKey: keysYesterday.weekly });
    }

    if (isMonthlyTransition) {
      periodsToSnapshot.push({ period: RankingPeriod.MONTHLY, dateKey: keysYesterday.monthly });
    }

    const types = ['gifters', 'receivers', 'families', 'streamers'] as const;

    for (const { period, dateKey } of periodsToSnapshot) {
      for (const type of types) {
        const key = `rankings:${type}:${period}:${dateKey}`;
        const topList = await this.repo.getTopFromRedis(key, 100);

        if (topList.length === 0) continue;

        const snapshots: Prisma.RankingSnapshotCreateManyInput[] = topList.map((entry, index) => ({
          type,
          period,
          dateKey,
          targetId: entry.member,
          rank: index + 1,
          score: BigInt(entry.score),
        }));

        try {
          await this.repo.saveSnapshots(snapshots);
          this.logger.log(`Saved ${snapshots.length} snapshots for ${type}:${period} (${dateKey})`);

          // Reclaim memory in Redis (expire in 30 days)
          await this.repo.setKeyTtl(key, 30 * 24 * 3600);
        } catch (err) {
          this.logger.error(
            `Failed to save snapshot for ${type}:${period} (${dateKey}): ${(err as Error).message}`,
          );
        }
      }
    }
  }

  // ---- Internal helper methods ----

  private resolveRankingKey(
    type: 'gifters' | 'receivers' | 'families' | 'streamers',
    period: RankingPeriod,
    date: Date = new Date(),
  ): { key: string; isPast: boolean; dateKey: string } {
    const todayKeys = this.getDateKeys(new Date());
    const queryKeys = this.getDateKeys(date);

    let dateKey = '';
    let isPast = false;

    if (period === RankingPeriod.ALLTIME) {
      dateKey = 'alltime';
    } else if (period === RankingPeriod.DAILY) {
      dateKey = queryKeys.daily;
      isPast = queryKeys.daily !== todayKeys.daily;
    } else if (period === RankingPeriod.WEEKLY) {
      dateKey = queryKeys.weekly;
      isPast = queryKeys.weekly !== todayKeys.weekly;
    } else if (period === RankingPeriod.MONTHLY) {
      dateKey = queryKeys.monthly;
      isPast = queryKeys.monthly !== todayKeys.monthly;
    }

    const key = `rankings:${type}:${period}:${dateKey}`;

    return { key, isPast, dateKey };
  }

  private async incrementAllPeriods(
    type: 'gifters' | 'receivers' | 'families' | 'streamers',
    member: string,
    delta: number,
    dailyKey: string,
    weeklyKey: string,
    monthlyKey: string,
  ): Promise<void> {
    const keys = [
      `rankings:${type}:alltime:alltime`,
      `rankings:${type}:daily:${dailyKey}`,
      `rankings:${type}:weekly:${weeklyKey}`,
      `rankings:${type}:monthly:${monthlyKey}`,
    ];

    await Promise.all(keys.map((k) => this.repo.incrementScore(k, member, delta)));
  }

  /**
   * Legacy key derivation, preserved exactly.
   *
   * `'local'` is passed deliberately: all three legacy keys — daily, weekly and
   * monthly — derive from the host's local calendar date. `dateKeyFor` defaults
   * to `'utc'`, so omitting `'local'` here would silently move the day boundary
   * under ladders already accumulating scores and split one day's data across
   * two Redis keys on the deploy. VR-13's own ladders are UTC throughout; this
   * seam is not the place to correct history.
   */
  private getDateKeys(date: Date): { daily: string; weekly: string; monthly: string } {
    return {
      daily: this.periods.dateKeyFor('daily', date, 'local'),
      weekly: this.periods.dateKeyFor('weekly', date, 'local'),
      monthly: this.periods.dateKeyFor('monthly', date, 'local'),
    };
  }
}
