import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { WorkforceScopeService } from './workforce-scope.service';

/**
 * Mobile read models for the operational workforce — Country Manager, Official
 * and Moderator.
 *
 * Every query is narrowed by the caller's geographic scope, so two officials in
 * different countries running the same request see different data. Read-only:
 * enforcement still goes through the moderation services, which apply the rank
 * rules a mobile client must not be able to sidestep.
 */
@Injectable()
export class MobileWorkforceService {
  private readonly logger = new Logger(MobileWorkforceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: WorkforceScopeService,
    private readonly scopes: GeographicScopeResolver,
  ) {}

  /** What geography am I responsible for? Drives the client's header and filters. */
  async myScope(userId: string) {
    const [assignments, described] = await Promise.all([
      this.scopes.getUserScopes(userId),
      this.scope.describeScope(userId),
    ]);

    return {
      assignments: assignments.map((s) => ({
        role: s.roleName,
        scopeType: s.scopeType,
        countryCode: s.countryCode ?? null,
        stateCode: s.stateCode ?? null,
        regionCode: s.regionCode ?? null,
      })),
      isUnrestricted: described.isUnrestricted,
      predicates: described.predicates,
    };
  }

  /** Population summary within my scope. */
  async summary(userId: string) {
    const where = await this.scope.userScopeFilter(userId);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [total, active, suspended, banned, newToday] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.count({ where: { ...where, status: 'ACTIVE' } }),
      this.prisma.user.count({ where: { ...where, status: 'SUSPENDED' } }),
      this.prisma.user.count({ where: { ...where, status: 'BANNED' } }),
      this.prisma.user.count({ where: { ...where, createdAt: { gte: dayAgo } } }),
    ]);

    return { totalUsers: total, activeUsers: active, suspended, banned, newUsersToday: newToday };
  }

  /** Users within my scope, searchable by username or email. */
  async users(userId: string, query?: string, limit = 25, offset = 0) {
    const scopeWhere = await this.scope.userScopeFilter(userId);

    // AND, not a spread: the scope filter is itself an `OR`, and spreading a
    // search `OR` on top would replace it — silently letting a scoped official
    // find users outside their territory.
    const where = {
      AND: [
        scopeWhere,
        ...(query
          ? [
              {
                OR: [
                  { username: { contains: query, mode: 'insensitive' as const } },
                  { email: { contains: query, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };

    const [total, items] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 100),
        skip: offset,
        select: {
          id: true,
          username: true,
          email: true,
          status: true,
          country: true,
          countryId: true,
          stateId: true,
          regionId: true,
          createdAt: true,
        },
      }),
    ]);

    return { total, items };
  }

  /**
   * Moderation queue for my scope.
   *
   * Reports carry no geography, so they are narrowed by the reporter's location
   * — the closest honest proxy available. The reporter set is resolved through
   * the same scope filter as every other query, so the queue and the user list
   * can never disagree about who is in territory.
   */
  async moderationQueue(userId: string, limit = 25) {
    const scopeWhere = await this.scope.userScopeFilter(userId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    let reporterFilter: Record<string, unknown> = {};
    if (!isUnrestricted) {
      const inScope = await this.prisma.user.findMany({
        where: scopeWhere,
        select: { id: true },
      });
      reporterFilter = { reporterId: { in: inScope.map((u) => u.id) } };
    }

    const where = { status: 'PENDING' as const, ...reporterFilter };

    const [audioReports, videoReports] = await Promise.all([
      this.prisma.roomReport.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: Math.min(limit, 100),
      }),
      this.prisma.videoRoomReport.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: Math.min(limit, 100),
      }),
    ]);

    return { audioRoomReports: audioReports, videoRoomReports: videoReports };
  }
}
