import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated, normalizePagination } from 'src/common/utils/pagination.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import type { UserCard } from '../../interfaces/profile.interface';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';

export const USER_SEARCH_PROVIDER = Symbol('USER_SEARCH_PROVIDER');

export interface UserSearchOptions {
  page?: number;
  limit?: number;
  country?: string;
  /** User ids to omit from results (e.g. the viewer's block relationships). */
  excludeIds?: string[];
  /**
   * Include platform-staff accounts. Off by default — a hidden account must not
   * surface to ordinary users, and search is the most direct way it otherwise
   * would. Only privileged admin-console callers set this.
   */
  includeHidden?: boolean;
}

/**
 * Search abstraction — the seam that keeps the query engine swappable. Today a
 * Postgres implementation; a Meili/Elasticsearch provider can replace the
 * binding without touching ProfileService (which emits user.profile_updated so
 * an external index can stay in sync).
 */
export interface IUserSearchProvider {
  search(query: string, opts: UserSearchOptions): Promise<Paginated<UserCard>>;
}

/**
 * Postgres-backed user search: case-insensitive prefix/substring match on
 * username + fullName over active, non-deleted accounts, then a bounded
 * hydration of avatar/level/verified for the page. Bounded by MAX_LIMIT (100),
 * so the per-page related-row fetches stay cheap.
 */
@Injectable()
export class PostgresUserSearchProvider implements IUserSearchProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaUrlResolver,
  ) {}

  async search(query: string, opts: UserSearchOptions): Promise<Paginated<UserCard>> {
    const { page, limit, skip } = normalizePagination(opts);
    const q = query.trim();
    if (!q) {
      return buildPaginated([], 0, page, limit);
    }

    const cleanHex = q.replace(/-/g, '');
    const isHexLike = /^[0-9a-f]{8,36}$/i.test(cleanHex);
    const isNumeric = /^\d{1,10}$/.test(q);

    let idMatchedUsers: {
      id: string;
      displayId?: number;
      username: string;
      fullName: string | null;
      country: string | null;
    }[] = [];
    if (isNumeric) {
      const pattern = `${q}%`;
      idMatchedUsers = await this.prisma.$queryRaw<
        {
          id: string;
          displayId?: number;
          username: string;
          fullName: string | null;
          country: string | null;
        }[]
      >`
        SELECT id, "displayId", username, "fullName", country
        FROM users
        WHERE "displayId"::text LIKE ${pattern}
          AND status = 'ACTIVE'
          AND "deletedAt" IS NULL
          ${opts.includeHidden ? Prisma.empty : Prisma.sql`AND "isHiddenAccount" = false`}
      `;
    } else if (isHexLike) {
      const pattern = `${q.toLowerCase()}%`;
      idMatchedUsers = await this.prisma.$queryRaw<
        {
          id: string;
          displayId?: number;
          username: string;
          fullName: string | null;
          country: string | null;
        }[]
      >`
        SELECT id, "displayId", username, "fullName", country
        FROM users
        WHERE id::text ILIKE ${pattern}
          AND status = 'ACTIVE'
          AND "deletedAt" IS NULL
          ${opts.includeHidden ? Prisma.empty : Prisma.sql`AND "isHiddenAccount" = false`}
      `;
    }

    const words = q.split(/\s+/).filter(Boolean);
    const searchConditions: Prisma.UserWhereInput[] = [
      { username: { contains: q, mode: 'insensitive' } },
      { fullName: { contains: q, mode: 'insensitive' } },
    ];
    if (words.length > 1) {
      searchConditions.push({
        AND: words.map((w) => ({
          OR: [
            { username: { contains: w, mode: 'insensitive' } },
            { fullName: { contains: w, mode: 'insensitive' } },
          ],
        })),
      });
    }

    const where: Prisma.UserWhereInput = {
      status: 'ACTIVE',
      deletedAt: null,
      ...(opts.includeHidden ? {} : { isHiddenAccount: false }),
      OR: searchConditions,
      ...(opts.country ? { country: opts.country } : {}),
      ...(opts.excludeIds && opts.excludeIds.length > 0 ? { id: { notIn: opts.excludeIds } } : {}),
    };

    const [usernameOrNameRows, totalCount] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ username: 'asc' }],
        select: { id: true, displayId: true, username: true, fullName: true, country: true },
      }),
      this.prisma.user.count({ where }),
    ]);

    const combinedMap = new Map<
      string,
      {
        id: string;
        displayId?: number;
        username: string;
        fullName: string | null;
        country: string | null;
      }
    >();
    for (const u of idMatchedUsers) {
      combinedMap.set(u.id, u);
    }
    for (const u of usernameOrNameRows) {
      combinedMap.set(u.id, u);
    }

    const rows = Array.from(combinedMap.values()).slice(0, limit);
    const total = Math.max(combinedMap.size, totalCount);

    const cards = await this.hydrate(rows);
    return buildPaginated(cards, total, page, limit);
  }

  /** Attach avatar/verified/level/vipLevel for the page's users. */
  private async hydrate(
    rows: {
      id: string;
      displayId?: number;
      username: string;
      fullName: string | null;
      country: string | null;
    }[],
  ): Promise<UserCard[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [profiles, stats, verifications] = await Promise.all([
      this.prisma.userProfile.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, avatarKey: true },
      }),
      this.prisma.userStatistics.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, level: true, wealthLevel: true },
      }),
      this.prisma.userVerification.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, verified: true },
      }),
    ]);
    const avatarByUser = new Map(profiles.map((p) => [p.userId, p.avatarKey]));
    const statByUser = new Map(stats.map((s) => [s.userId, s]));
    const verifiedByUser = new Map(verifications.map((v) => [v.userId, v.verified]));

    return Promise.all(
      rows.map(async (r): Promise<UserCard> => {
        const stat = statByUser.get(r.id);
        return {
          id: r.id,
          displayId: r.displayId,
          username: r.username,
          fullName: r.fullName,
          country: r.country,
          avatarUrl: await this.media.resolve(avatarByUser.get(r.id)),
          verified: verifiedByUser.get(r.id) ?? false,
          level: stat?.level ?? 1,
          vipLevel: stat?.wealthLevel ?? 0,
        };
      }),
    );
  }
}
