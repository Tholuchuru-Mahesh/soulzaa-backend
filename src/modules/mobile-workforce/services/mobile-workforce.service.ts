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

  /**
   * Comprehensive Official Portal dashboard.
   *
   * Returns all metrics required by the mobile dashboard in a single parallel
   * batch. Every metric is narrowed to the caller's geographic scope — two
   * officials in different territories see different numbers.
   */
  async dashboard(userId: string) {
    const scopeWhere = await this.scope.userScopeFilter(userId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;
    const now = new Date();

    // Re-map user scope predicates (countryId/stateId/regionId on the User
    // table) to the same columns on entity tables (live_streams, support_tickets etc.).
    const buildLocationFilter = (sw: typeof scopeWhere): Record<string, unknown> => {
      if (isUnrestricted || !('OR' in sw)) return {};
      return {
        OR: sw.OR.map((clause) => {
          const out: Record<string, unknown> = {};
          if ('countryId' in clause) out['countryId'] = clause['countryId'];
          if ('stateId' in clause) out['stateId'] = clause['stateId'];
          if ('regionId' in clause) out['regionId'] = clause['regionId'];
          return out;
        }),
      };
    };

    const locationFilter = buildLocationFilter(scopeWhere);

    // Resolve in-scope user IDs once for queries that join via ownerId/founderId.
    let inScopeUserIds: string[] | null = null;
    if (!isUnrestricted) {
      const scopeUsers = await this.prisma.user.findMany({
        where: scopeWhere,
        select: { id: true },
        take: 10_000,
      });
      inScopeUserIds = scopeUsers.map((u) => u.id);
    }

    const ownerFilter = inScopeUserIds !== null ? { ownerId: { in: inScopeUserIds } } : {};
    const founderFilter = inScopeUserIds !== null ? { founderId: { in: inScopeUserIds } } : {};
    const reporterFilter = inScopeUserIds !== null ? { reporterId: { in: inScopeUserIds } } : {};

    const [
      totalUsers,
      activeCreators,
      totalAgencies,
      activeCoinSellers,
      activeFamilies,
      liveAudioRooms,
      liveVideoRooms,
      liveStreams,
      pendingAgencyRequests,
      pendingCoinSellerRequests,
      pendingAudioReports,
      pendingVideoReports,
      openSupportTickets,
      runningEvents,
      tasksAssigned,
      openContentRequests,
      activeCampaigns,
      activeCommunityPrograms,
    ] = await Promise.all([
      // 1. Total users in scope
      this.prisma.user.count({ where: scopeWhere }),

      // 2. Active creators (HOST or CREATOR role) in scope
      this.prisma.user.count({
        where: { ...scopeWhere, status: 'ACTIVE', roles: { hasSome: ['HOST', 'CREATOR'] as any } },
      }),

      // 3. Active agency relationships for users in scope
      inScopeUserIds !== null
        ? this.prisma.agencyRelationship.count({
            where: { agencyId: { in: inScopeUserIds }, status: 'ACTIVE' },
          })
        : this.prisma.agencyRelationship.count({ where: { status: 'ACTIVE' } }),

      // 4. Active coin sellers in scope
      this.prisma.user.count({
        where: { ...scopeWhere, status: 'ACTIVE', roles: { hasSome: ['COIN_SELLER'] as any } },
      }),

      // 5. Active families whose founder is in scope
      this.prisma.family.count({ where: { ...founderFilter, status: 'ACTIVE' } }),

      // 6. Live audio rooms owned by someone in scope
      this.prisma.audioRoom.count({ where: { ...ownerFilter, status: 'LIVE' } }),

      // 7. Live video rooms owned by someone in scope
      this.prisma.videoRoom.count({ where: { ...ownerFilter, status: 'LIVE' } }),

      // 8. Live streams in territory
      this.prisma.liveStream.count({ where: { status: 'LIVE', ...locationFilter } }),

      // 9. Pending agency role requests in territory
      inScopeUserIds !== null
        ? this.prisma.roleRequest.count({
            where: {
              type: 'AGENCY' as any,
              status: 'SUBMITTED' as any,
              subjectUserId: { in: inScopeUserIds },
            },
          })
        : this.prisma.roleRequest.count({
            where: { type: 'AGENCY' as any, status: 'SUBMITTED' as any },
          }),

      // 10. Pending coin seller role requests in territory
      inScopeUserIds !== null
        ? this.prisma.roleRequest.count({
            where: {
              type: 'COIN_SELLER' as any,
              status: 'SUBMITTED' as any,
              subjectUserId: { in: inScopeUserIds },
            },
          })
        : this.prisma.roleRequest.count({
            where: { type: 'COIN_SELLER' as any, status: 'SUBMITTED' as any },
          }),

      // 11a. Pending audio room reports from reporters in scope
      this.prisma.roomReport.count({ where: { status: 'PENDING', ...reporterFilter } }),

      // 11b. Pending video room reports from reporters in scope
      this.prisma.videoRoomReport.count({ where: { status: 'PENDING', ...reporterFilter } }),

      // 12. Open support tickets in territory
      this.prisma.supportTicket.count({
        where: { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] }, ...locationFilter },
      }),

      // 13. Running platform events (currently active)
      this.prisma.platformEvent.count({
        where: { enabled: true, startAt: { lte: now }, endAt: { gte: now } },
      }),

      // 14. Tasks assigned to this official that are in-progress (not yet completed)
      this.prisma.taskProgress.count({ where: { userId, isCompleted: false } }),

      // 15. Open content requests in territory
      this.prisma.contentRequest.count({
        where: { status: { in: ['OPEN', 'IN_REVIEW'] }, ...locationFilter },
      }),

      // 16. Active campaigns in territory
      this.prisma.campaign.count({
        where: { status: { in: ['ACTIVE', 'DRAFT'] }, ...locationFilter },
      }),

      // 17. Active community programs in territory
      this.prisma.communityProgram.count({
        where: { isActive: true, ...locationFilter },
      }),
    ]);

    return {
      regionalOverview: {
        totalUsers,
        activeCreators,
        totalAgencies,
        activeCoinSellers,
        activeFamilies,
        liveAudioRooms,
        liveVideoRooms,
        liveStreams,
      },
      pendingActions: {
        agencyRequests: pendingAgencyRequests,
        coinSellerRequests: pendingCoinSellerRequests,
        reports: pendingAudioReports + pendingVideoReports,
        supportTickets: openSupportTickets,
        contentRequests: openContentRequests,
        tasksAssigned,
      },
      runningActivities: {
        events: runningEvents,
        campaigns: activeCampaigns,
        communityPrograms: activeCommunityPrograms,
      },
      generatedAt: now.toISOString(),
    };
  }
}
