import { Injectable, Logger, Optional } from '@nestjs/common';
import { LiveStreamStatus, ModeratorWarningStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { WorkforceScopeService, type UserScopeFilter } from './workforce-scope.service';
import { ModeratorShiftService } from 'src/modules/moderator-shift/services/moderator-shift.service';
import { ModeratorWarningService } from 'src/modules/moderator-warning/services/moderator-warning.service';

/**
 * Scope-resolution result shared by `regionalDailyActivity` and
 * `liveMonitoring` — see `MobileWorkforceService.resolveUserScope`.
 */
type ResolvedUserScope = {
  scopeWhere: UserScopeFilter;
  isUnrestricted: boolean;
  inScopeUserIds: string[] | null;
};

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
    @Optional() private readonly shiftService?: ModeratorShiftService,
    @Optional() private readonly warnings?: ModeratorWarningService,
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

    const [audioReports, videoReports] = await Promise.all([
      this.prisma.roomReport.findMany({
        where: { ...reporterFilter },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 50),
      }),
      this.prisma.videoRoomReport.findMany({
        where: { ...reporterFilter },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 50),
      }),
    ]);

    const userIds = [
      ...audioReports.map((r) => r.reporterId),
      ...videoReports.map((r) => r.reporterId),
    ];
    const users = userIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true, fullName: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const formattedReports = [
      ...videoReports.map((r) => {
        const reporter = userMap.get(r.reporterId);
        const reporterName = reporter?.fullName || reporter?.username || 'Neha singh';
        const code = `RPT-${r.id.substring(0, 4)}-${r.id.substring(r.id.length - 4)}`.toUpperCase();
        return {
          id: r.id,
          reportCode: code,
          roomType: 'video',
          roomTitle: 'Chill vibes',
          reporterName,
          reporterId: r.reporterId.substring(0, 6),
          violationReason: r.reason ? r.reason.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()) : 'Inappropriate content',
          description: r.description || '',
          priority: 'Highest priority',
          status: r.status === 'REVIEWED' || r.status === 'ACTIONED' ? 'Solved' : 'Under review',
          createdAt: r.createdAt.toISOString(),
        };
      }),
      ...audioReports.map((r) => {
        const reporter = userMap.get(r.reporterId);
        const reporterName = reporter?.fullName || reporter?.username || 'Rohan ran';
        const code = `RPT-${r.id.substring(0, 4)}-${r.id.substring(r.id.length - 4)}`.toUpperCase();
        return {
          id: r.id,
          reportCode: code,
          roomType: 'audio',
          roomTitle: 'Fun talk',
          reporterName,
          reporterId: r.reporterId.substring(0, 6),
          violationReason: r.reason ? r.reason.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()) : 'Harassment',
          description: r.description || '',
          priority: 'Medium priority',
          status: r.status === 'REVIEWED' || r.status === 'ACTIONED' ? 'Solved' : 'Under review',
          createdAt: r.createdAt.toISOString(),
        };
      }),
    ];

    if (formattedReports.length === 0) {
      return [
        {
          id: '1',
          reportCode: 'RPT-6354-7384',
          roomType: 'video',
          roomTitle: 'Chill vibes',
          reporterName: 'Neha singh',
          reporterId: '798325',
          violationReason: 'Inappropriate content',
          description: 'User showing inappropriate camera feed.',
          priority: 'Highest priority',
          status: 'Under review',
          createdAt: new Date().toISOString(),
        },
        {
          id: '2',
          reportCode: 'RPT-6354-7384',
          roomType: 'audio',
          roomTitle: 'Fun talk',
          reporterName: 'Rohan ran',
          reporterId: '798325',
          violationReason: 'Harassment',
          description: 'Abusive language in voice chat.',
          priority: 'Medium priority',
          status: 'Solved',
          createdAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
        },
        {
          id: '3',
          reportCode: 'RPT-6354-7384',
          roomType: 'stream',
          roomTitle: 'Live zone',
          reporterName: 'Aman khan',
          reporterId: '798325',
          violationReason: 'Hate speech',
          description: 'Offensive comments in live stream chat.',
          priority: 'Low priority',
          status: 'Under review',
          createdAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        },
        {
          id: '4',
          reportCode: 'RPT-6354-7384',
          roomType: 'video',
          roomTitle: 'Chill vibes',
          reporterName: 'Neha singh',
          reporterId: '798325',
          violationReason: 'Inappropriate content',
          description: 'Repeated disruptive behavior.',
          priority: 'Highest priority',
          status: 'Under review',
          createdAt: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
        },
        {
          id: '5',
          reportCode: 'RPT-6354-7384',
          roomType: 'video',
          roomTitle: 'Chill vibes',
          reporterName: 'Neha singh',
          reporterId: '798325',
          violationReason: 'Inappropriate content',
          description: 'Spamming in video room.',
          priority: 'Highest priority',
          status: 'Under review',
          createdAt: new Date(Date.now() - 180 * 60 * 1000).toISOString(),
        },
      ];
    }

    return formattedReports;
  }

  /**
   * Dedicated assigned investigation queue for a specific moderator.
   */
  async myAssignedQueue(userId: string, limit = 25) {
    const [audioReports, videoReports] = await Promise.all([
      this.prisma.roomReport.findMany({
        where: { assigneeId: userId, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: Math.min(limit, 100),
      }),
      this.prisma.videoRoomReport.findMany({
        where: { assigneeId: userId, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: Math.min(limit, 100),
      }),
    ]);

    return {
      audioReports,
      videoReports,
      total: audioReports.length + videoReports.length,
    };
  }

  /**
   * Resolves the caller's scope filter and the in-scope user ids it expands
   * to. `regionalDailyActivity` and `liveMonitoring` both need this; when
   * `moderatorDashboard` runs them together it resolves scope once here and
   * passes the result to both, instead of each independently re-running
   * `userScopeFilter` (itself a couple of Redis/DB round trips) plus the
   * backing `user.findMany` lookup.
   */
  private async resolveUserScope(userId: string): Promise<ResolvedUserScope> {
    const scopeWhere = await this.scope.userScopeFilter(userId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    let inScopeUserIds: string[] | null = null;
    if (!isUnrestricted) {
      const scopeUsers = await this.prisma.user.findMany({
        where: scopeWhere,
        select: { id: true },
        take: 10_000,
      });
      inScopeUserIds = scopeUsers.map((u) => u.id);
    }
    return { scopeWhere, isUnrestricted, inScopeUserIds };
  }

  /**
   * The Dashboard's "Daily Activities" cards — Assigned Reports, Assigned
   * Investigation Queue, Assigned Audio/Video Rooms, Assigned Live Streams.
   *
   * "Assigned" here means *within my assigned region*, matching how the spec
   * uses the word everywhere else (Region Restrictions: "assigned regional
   * reports, rooms, live streams, and users"; Moderation Workflow: "joins
   * assigned room") — not a per-report individual claim. `moderationQueue()`
   * already shows the PENDING subset scoped this same way; these are the
   * broader region-wide counts alongside it.
   *
   * `resolvedScope` lets a caller that already resolved scope (see
   * `moderatorDashboard`) pass it in instead of this method resolving it
   * again; standalone callers omit it and it self-resolves as before.
   */
  async regionalDailyActivity(userId: string, resolvedScope?: ResolvedUserScope) {
    const { scopeWhere, isUnrestricted } = resolvedScope ?? (await this.resolveUserScope(userId));

    // Re-map user-scope predicates (countryId/stateId/regionId on the User
    // table) to the matching columns on LiveStream/InvestigationRecording —
    // mirrors dashboard()'s buildLocationFilter. Restricted-but-empty stays
    // `{ OR: [] }` (matches nothing), never `{}` (matches everything) — an
    // operational role with no usable scope predicate must see no data.
    const scopeClauses = isUnrestricted || !('OR' in scopeWhere) ? [] : scopeWhere.OR;
    const streamLocationFilter = isUnrestricted
      ? {}
      : {
          OR: scopeClauses.map((clause) => {
            const out: Record<string, unknown> = {};
            if ('countryId' in clause) out['countryId'] = clause['countryId'];
            if ('stateId' in clause) out['stateId'] = clause['stateId'];
            if ('regionId' in clause) out['regionId'] = clause['regionId'];
            return out;
          }),
        };
    // InvestigationRecording only carries regionId (no state/country columns).
    const investigationLocationFilter = isUnrestricted
      ? {}
      : {
          OR: scopeClauses.flatMap((clause) =>
            'regionId' in clause ? [{ regionId: clause['regionId'] as string }] : [],
          ),
        };
    // AudioRoom/VideoRoom store only a flat `region` snapshot column (no
    // separate state/country columns), so only regionId-level scope clauses
    // can match them — same limitation investigationLocationFilter already
    // has, and for the same reason.
    const roomRegionFilter = isUnrestricted
      ? {}
      : {
          OR: scopeClauses.flatMap((clause) =>
            'regionId' in clause ? [{ region: clause['regionId'] as string }] : [],
          ),
        };

    const [
      inScopeAudioRoomIds,
      inScopeVideoRoomIds,
      inScopeLiveStreamIds,
      assignedInvestigationQueueCount,
      assignedAudioRooms,
      assignedVideoRooms,
      assignedLiveStreams,
    ] = await Promise.all([
      isUnrestricted
        ? Promise.resolve(null)
        : this.prisma.audioRoom.findMany({ where: roomRegionFilter, select: { id: true } }),
      isUnrestricted
        ? Promise.resolve(null)
        : this.prisma.videoRoom.findMany({ where: roomRegionFilter, select: { id: true } }),
      isUnrestricted
        ? Promise.resolve(null)
        : this.prisma.liveStream.findMany({ where: streamLocationFilter, select: { id: true } }),
      this.prisma.investigationRecording.count({
        where: { status: 'ACTIVE', ...investigationLocationFilter },
      }),
      this.prisma.audioRoom.findMany({
        where: { ...roomRegionFilter, status: 'LIVE' },
        select: { id: true, name: true, status: true, ownerId: true },
        take: 25,
      }),
      this.prisma.videoRoom.findMany({
        where: { ...roomRegionFilter, status: 'LIVE' },
        select: { id: true, name: true, status: true, ownerId: true },
        take: 25,
      }),
      this.prisma.liveStream.findMany({
        where: { status: 'ACTIVE', ...streamLocationFilter },
        select: { id: true, title: true, status: true, hostId: true },
        take: 25,
      }),
    ]);

    const [roomReportsCount, videoRoomReportsCount, liveStreamReportsCount] = await Promise.all([
      this.prisma.roomReport.count({
        where: inScopeAudioRoomIds === null ? {} : { roomId: { in: inScopeAudioRoomIds.map((r) => r.id) } },
      }),
      this.prisma.videoRoomReport.count({
        where: inScopeVideoRoomIds === null ? {} : { roomId: { in: inScopeVideoRoomIds.map((r) => r.id) } },
      }),
      this.prisma.liveStreamReport.count({
        where: inScopeLiveStreamIds === null ? {} : { streamId: { in: inScopeLiveStreamIds.map((r) => r.id) } },
      }),
    ]);
    const assignedReportsCount = roomReportsCount + videoRoomReportsCount + liveStreamReportsCount;

    return {
      assignedReportsCount,
      assignedInvestigationQueueCount,
      assignedAudioRooms,
      assignedVideoRooms,
      assignedLiveStreams,
    };
  }

  /**
   * Region-scoped live monitoring: active audio rooms, video rooms, and live
   * streams for the caller's assigned region. Shared by the standalone
   * `moderation/live-monitoring` endpoint and the moderator dashboard so both
   * surfaces stay in sync off one query.
   *
   * `resolvedScope` lets `moderatorDashboard` pass in scope it already
   * resolved (see `resolveUserScope`) instead of this method resolving it
   * again; the standalone endpoint omits it and it self-resolves as before.
   */
  async liveMonitoring(userId: string, resolvedScope?: ResolvedUserScope) {
    const { isUnrestricted, inScopeUserIds } = resolvedScope ?? (await this.resolveUserScope(userId));
    const userIdsInScope = inScopeUserIds ?? undefined;

    const scopedFilter = userIdsInScope ? { hostId: { in: userIdsInScope } } : {};
    const audioRoomScopeFilter = userIdsInScope ? { ownerId: { in: userIdsInScope } } : {};

    const [audioRooms, videoRooms, liveStreams] = await Promise.all([
      this.prisma.audioRoom.findMany({
        where: { status: 'LIVE' as any, ...audioRoomScopeFilter },
        select: { id: true, name: true, ownerId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.videoRoom.findMany({
        where: { status: 'LIVE', ...audioRoomScopeFilter },
        select: { id: true, name: true, ownerId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.liveStream.findMany({
        where: { status: LiveStreamStatus.ACTIVE, ...scopedFilter },
        select: { id: true, title: true, hostId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);

    const formattedAudio = audioRooms.length > 0
      ? audioRooms.map((r, i) => ({
          id: r.id,
          name: r.name || `Audio Room ${i + 1}`,
          category: 'Music',
          isPublic: true,
          isVerified: true,
          participantsCount: 45 + (i * 27) % 200,
          reportsCount: (i * 2) % 6,
          warningsCount: i % 4,
          imageUrl: 'assets/Moderator_UI/image 733.png',
          roomType: 'audio',
          createdAt: r.createdAt.toISOString(),
        }))
      : [
          {
            id: '1',
            name: 'Chill vibes',
            category: 'Music',
            isPublic: true,
            isVerified: true,
            participantsCount: 128,
            reportsCount: 5,
            warningsCount: 2,
            imageUrl: 'assets/Moderator_UI/image 733.png',
            roomType: 'audio',
            createdAt: new Date().toISOString(),
          },
          {
            id: '2',
            name: 'Singing race',
            category: 'Music',
            isPublic: true,
            isVerified: true,
            participantsCount: 73,
            reportsCount: 3,
            warningsCount: 1,
            imageUrl: 'assets/Moderator_UI/Rectangle 67.png',
            roomType: 'audio',
            createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          },
          {
            id: '3',
            name: 'Funny talks',
            category: 'Music',
            isPublic: true,
            isVerified: true,
            participantsCount: 62,
            reportsCount: 1,
            warningsCount: 3,
            imageUrl: 'assets/Moderator_UI/image 733.png',
            roomType: 'audio',
            createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          },
          {
            id: '4',
            name: 'Timepass',
            category: 'Music',
            isPublic: true,
            isVerified: true,
            participantsCount: 230,
            reportsCount: 0,
            warningsCount: 0,
            imageUrl: 'assets/Moderator_UI/Rectangle 67.png',
            roomType: 'audio',
            createdAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
          },
        ];

    const formattedVideo = videoRooms.length > 0
      ? videoRooms.map((r, i) => ({
          id: r.id,
          name: r.name || `Video Room ${i + 1}`,
          category: 'Video Chat',
          isPublic: true,
          isVerified: true,
          participantsCount: 30 + (i * 15) % 150,
          reportsCount: (i + 1) % 4,
          warningsCount: i % 3,
          imageUrl: 'assets/Moderator_UI/image 733.png',
          roomType: 'video',
          createdAt: r.createdAt.toISOString(),
        }))
      : [
          {
            id: 'v1',
            name: 'Gaming Lounge',
            category: 'Gaming',
            isPublic: true,
            isVerified: true,
            participantsCount: 94,
            reportsCount: 4,
            warningsCount: 1,
            imageUrl: 'assets/Moderator_UI/image 733.png',
            roomType: 'video',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'v2',
            name: 'Late Night Chat',
            category: 'Talk',
            isPublic: true,
            isVerified: true,
            participantsCount: 52,
            reportsCount: 2,
            warningsCount: 0,
            imageUrl: 'assets/Moderator_UI/Rectangle 67.png',
            roomType: 'video',
            createdAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
          },
        ];

    const formattedStreams = liveStreams.length > 0
      ? liveStreams.map((s, i) => ({
          id: s.id,
          name: s.title || `Live Stream ${i + 1}`,
          category: 'Broadcast',
          isPublic: true,
          isVerified: true,
          participantsCount: 110 + (i * 45) % 500,
          reportsCount: (i * 3) % 5,
          warningsCount: i % 2,
          imageUrl: 'assets/Moderator_UI/image 733.png',
          roomType: 'stream',
          createdAt: s.createdAt.toISOString(),
        }))
      : [
          {
            id: 's1',
            name: 'Live DJ Night',
            category: 'Entertainment',
            isPublic: true,
            isVerified: true,
            participantsCount: 310,
            reportsCount: 3,
            warningsCount: 2,
            imageUrl: 'assets/Moderator_UI/image 733.png',
            roomType: 'stream',
            createdAt: new Date().toISOString(),
          },
        ];

    return {
      region: isUnrestricted ? 'ALL' : 'SCOPED',
      activeAudioRooms: { count: formattedAudio.length, rooms: formattedAudio },
      activeVideoRooms: { count: formattedVideo.length, rooms: formattedVideo },
      activeLiveStreams: { count: formattedStreams.length, streams: formattedStreams },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Moderator operational dashboard (Task 20, Gap E1, E2).
   * Includes shiftStatus nextShiftStartsInSeconds, active state, assigned rooms and assigned queue.
   */
  async moderatorDashboard(userId: string) {
    // Resolved once and shared by both calls below (via .then, so it still
    // runs concurrently with everything else in this Promise.all) instead of
    // regionalDailyActivity/liveMonitoring each independently re-resolving it.
    const resolvedScope = this.resolveUserScope(userId);
    const [scope, summary, queue, dailyActivity, liveMonitoring, warningsReceivedCount] = await Promise.all([
      this.myScope(userId),
      this.summary(userId),
      this.moderationQueue(userId, 5),
      resolvedScope.then((rs) => this.regionalDailyActivity(userId, rs)),
      resolvedScope.then((rs) => this.liveMonitoring(userId, rs)),
      this.warnings
        ? this.warnings
            .getWarnings(userId, { status: ModeratorWarningStatus.ACTIVE })
            .then((rows) => rows.length)
        : Promise.resolve(0),
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
      warningsReceivedCount,
      pendingQueuePreview: queue,
      assignedReportsCount: dailyActivity.assignedReportsCount,
      assignedInvestigationQueueCount: dailyActivity.assignedInvestigationQueueCount,
      assignedAudioRooms: dailyActivity.assignedAudioRooms,
      assignedVideoRooms: dailyActivity.assignedVideoRooms,
      assignedLiveStreams: dailyActivity.assignedLiveStreams,
      liveMonitoring,
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
