import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { WorkforceScopeService } from './workforce-scope.service';
import { ModeratorShiftService } from 'src/modules/moderator-shift/services/moderator-shift.service';

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
    private readonly shiftService?: ModeratorShiftService,
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

    return this.prisma.roomReport.findMany({
      where: { status: 'PENDING', ...reporterFilter },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
  }

  /**
   * Moderator operational dashboard (Task 20).
   * Includes shiftStatus nextShiftStartsInSeconds and active state.
   */
  async moderatorDashboard(userId: string) {
    const [scope, summary, queue] = await Promise.all([
      this.myScope(userId),
      this.summary(userId),
      this.moderationQueue(userId, 5),
    ]);

    // Shift info & countdown (Task 20)
    let shift = await this.prisma.moderatorShift.findFirst({
      where: { moderatorId: userId, isActive: true },
    });
    let nextShiftStartsInSeconds: number | null = null;
    let shiftActive = false;

    if (this.shiftService) {
      const status = await this.shiftService.shiftStatus(userId);
      shiftActive = status.isActive;
      nextShiftStartsInSeconds = status.nextShiftStartsInSeconds;
      if (status.shift) {
        shift = status.shift as any;
      }
    }

    // Today's stats
    const dateKey = new Date().toISOString().slice(0, 10);
    const todayStats = await this.prisma.moderatorDailyStats.findUnique({
      where: { moderatorId_dateKey: { moderatorId: userId, dateKey } },
    });

    return {
      scope,
      populationSummary: summary,
      shift: shift ?? null,
      shiftActive,
      nextShiftStartsInSeconds,
      todayStats: todayStats ?? null,
      pendingQueuePreview: queue,
    };
  }
}
