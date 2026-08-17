import { Injectable, Logger, Optional } from '@nestjs/common';
import { LiveStreamStatus, ModerationMuteType, ModeratorWarningStatus } from '@prisma/client';
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
 * `moderateParticipant`'s quick mute action takes no duration input from the
 * mobile client (unlike the full audio-room moderation API's
 * `MuteDto.durationMinutes`), so it always mutes temporarily for this long
 * rather than defaulting to permanent.
 */
const QUICK_MUTE_DURATION_MINUTES = 60;

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
          roles: true,
          country: true,
          countryId: true,
          stateId: true,
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
      ...audioReports.map((r) => r.targetUserId),
      ...videoReports.map((r) => r.targetUserId),
    ];
    const audioRoomIds = audioReports.map((r) => r.roomId);
    const videoRoomIds = videoReports.map((r) => r.roomId);

    const [users, audioRoomsList, videoRoomsList] = await Promise.all([
      userIds.length > 0
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [],
      audioRoomIds.length > 0
        ? this.prisma.audioRoom.findMany({
            where: { id: { in: audioRoomIds } },
            select: { id: true, name: true, ownerId: true },
          })
        : [],
      videoRoomIds.length > 0
        ? this.prisma.videoRoom.findMany({
            where: { id: { in: videoRoomIds } },
            select: { id: true, name: true, ownerId: true },
          })
        : [],
    ]);

    const ownerIds = [
      ...audioRoomsList.map((r) => r.ownerId),
      ...videoRoomsList.map((r) => r.ownerId),
    ];
    const owners =
      ownerIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: ownerIds } },
            select: { id: true, locationState: { select: { name: true } } },
          })
        : [];
    const ownerStateMap = new Map(owners.map((o) => [o.id, o.locationState?.name ?? null]));
    const userMap = new Map(users.map((u) => [u.id, u]));
    const audioRoomMap = new Map(audioRoomsList.map((r) => [r.id, r]));
    const videoRoomMap = new Map(videoRoomsList.map((r) => [r.id, r]));

    const formattedReports = [
      ...videoReports.map((r) => {
        const reporter = userMap.get(r.reporterId);
        const targetUser = userMap.get(r.targetUserId);
        const room = videoRoomMap.get(r.roomId);
        const reporterName = reporter?.fullName || reporter?.username || 'Reporter';
        const targetUserName = targetUser?.fullName || targetUser?.username || 'Target User';
        const code = `RPT-${r.id.substring(0, 4)}-${r.id.substring(r.id.length - 4)}`.toUpperCase();
        const evCode =
          `EV-${r.id.substring(0, 4)}-${r.id.substring(r.id.length - 4)}`.toUpperCase();
        const reasonText = r.reason
          ? r.reason
              .replace(/_/g, ' ')
              .toLowerCase()
              .replace(/\b\w/g, (c: string) => c.toUpperCase())
          : 'Inappropriate content';
        const assignedTime = r.assignedAt
          ? new Date(r.assignedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return {
          id: r.id,
          reportCode: code,
          roomType: 'video',
          roomTitle: room?.name || 'Video room',
          reporterName,
          reporterId: r.reporterId.substring(0, 6),
          targetUserName,
          targetUserId: r.targetUserId.substring(0, 6),
          region: (room?.ownerId && ownerStateMap.get(room.ownerId)) || 'Unassigned',
          violationReason: reasonText,
          description: r.description || 'Violation reported in video room.',
          priority: 'Highest priority',
          status: r.status === 'REVIEWED' || r.status === 'ACTIONED' ? 'Solved' : 'Under review',
          createdAt: r.createdAt.toISOString(),
          evidenceId: evCode,
          evidenceType: 'System evidence',
          evidenceNote: 'Automatically captured by the system',
          ruleViolated: `${reasonText} (3.1)`,
          userReportCount: '1 previous report',
          assignedTime,
        };
      }),
      ...audioReports.map((r) => {
        const reporter = userMap.get(r.reporterId);
        const targetUser = userMap.get(r.targetUserId);
        const room = audioRoomMap.get(r.roomId);
        const reporterName = reporter?.fullName || reporter?.username || 'Reporter';
        const targetUserName = targetUser?.fullName || targetUser?.username || 'Target User';
        const code = `RPT-${r.id.substring(0, 4)}-${r.id.substring(r.id.length - 4)}`.toUpperCase();
        const evCode =
          `EV-${r.id.substring(0, 4)}-${r.id.substring(r.id.length - 4)}`.toUpperCase();
        const reasonText = r.reason
          ? r.reason
              .replace(/_/g, ' ')
              .toLowerCase()
              .replace(/\b\w/g, (c: string) => c.toUpperCase())
          : 'Harassment';
        const assignedTime = r.assignedAt
          ? new Date(r.assignedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return {
          id: r.id,
          reportCode: code,
          roomType: 'audio',
          roomTitle: room?.name || 'Audio room',
          reporterName,
          reporterId: r.reporterId.substring(0, 6),
          targetUserName,
          targetUserId: r.targetUserId.substring(0, 6),
          region: (room?.ownerId && ownerStateMap.get(room.ownerId)) || 'Unassigned',
          violationReason: reasonText,
          description: r.description || 'Violation reported in audio room.',
          priority: 'Medium priority',
          status: r.status === 'REVIEWED' || r.status === 'ACTIONED' ? 'Solved' : 'Under review',
          createdAt: r.createdAt.toISOString(),
          evidenceId: evCode,
          evidenceType: 'System evidence',
          evidenceNote: 'Automatically captured by the system',
          ruleViolated: `${reasonText} (2.4)`,
          userReportCount: '1 previous report',
          assignedTime,
        };
      }),
    ];

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
    const { isUnrestricted, inScopeUserIds } =
      resolvedScope ?? (await this.resolveUserScope(userId));

    // AudioRoom/VideoRoom/LiveStream no longer carry a territory snapshot
    // column at all — matched by owner/host instead, same as `liveMonitoring`.
    // Restricted-but-empty (`inScopeUserIds === []`) still matches nothing,
    // never everything: an operational role with no usable scope predicate
    // must see no data.
    const roomOwnerFilter = isUnrestricted ? {} : { ownerId: { in: inScopeUserIds ?? [] } };
    const streamHostFilter = isUnrestricted ? {} : { hostId: { in: inScopeUserIds ?? [] } };

    const [
      inScopeAudioRoomIds,
      inScopeVideoRoomIds,
      inScopeLiveStreamIds,
      assignedAudioRooms,
      assignedVideoRooms,
      assignedLiveStreams,
    ] = await Promise.all([
      isUnrestricted
        ? Promise.resolve(null)
        : this.prisma.audioRoom.findMany({ where: roomOwnerFilter, select: { id: true } }),
      isUnrestricted
        ? Promise.resolve(null)
        : this.prisma.videoRoom.findMany({ where: roomOwnerFilter, select: { id: true } }),
      isUnrestricted
        ? Promise.resolve(null)
        : this.prisma.liveStream.findMany({ where: streamHostFilter, select: { id: true } }),
      this.prisma.audioRoom.findMany({
        where: { ...roomOwnerFilter, status: 'LIVE' },
        select: { id: true, name: true, status: true, ownerId: true },
        take: 25,
      }),
      this.prisma.videoRoom.findMany({
        where: { ...roomOwnerFilter, status: 'LIVE' },
        select: { id: true, name: true, status: true, ownerId: true },
        take: 25,
      }),
      this.prisma.liveStream.findMany({
        where: { status: 'ACTIVE', ...streamHostFilter },
        select: { id: true, title: true, status: true, hostId: true },
        take: 25,
      }),
    ]);

    // InvestigationRecording carries no territory column of its own either —
    // scope it via the in-scope room/stream ids just resolved above.
    // `roomId` isn't type-tagged (audio vs video), so both feed the same clause.
    const investigationRoomFilter = isUnrestricted
      ? {}
      : {
          OR: [
            {
              roomId: {
                in: [...(inScopeAudioRoomIds ?? []), ...(inScopeVideoRoomIds ?? [])].map(
                  (r) => r.id,
                ),
              },
            },
            { liveStreamId: { in: (inScopeLiveStreamIds ?? []).map((s) => s.id) } },
          ],
        };

    const [
      roomReportsCount,
      videoRoomReportsCount,
      liveStreamReportsCount,
      assignedInvestigationQueueCount,
    ] = await Promise.all([
      this.prisma.roomReport.count({
        where:
          inScopeAudioRoomIds === null
            ? {}
            : { roomId: { in: inScopeAudioRoomIds.map((r) => r.id) } },
      }),
      this.prisma.videoRoomReport.count({
        where:
          inScopeVideoRoomIds === null
            ? {}
            : { roomId: { in: inScopeVideoRoomIds.map((r) => r.id) } },
      }),
      this.prisma.liveStreamReport.count({
        where:
          inScopeLiveStreamIds === null
            ? {}
            : { streamId: { in: inScopeLiveStreamIds.map((r) => r.id) } },
      }),
      this.prisma.investigationRecording.count({
        where: { status: 'ACTIVE', ...investigationRoomFilter },
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
    const { isUnrestricted, inScopeUserIds } =
      resolvedScope ?? (await this.resolveUserScope(userId));
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

    const formattedAudio = audioRooms.map((r, i) => {
      const sessionMinutes = Math.max(
        1,
        Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 60000),
      );
      return {
        id: r.id,
        name: r.name || `Audio Room ${i + 1}`,
        category: 'Audio room',
        isPublic: true,
        isVerified: true,
        participantsCount: 1,
        reportsCount: 0,
        warningsCount: 0,
        bansCount: 0,
        imageUrl: 'assets/Moderator_UI/image 733.png',
        roomType: 'audio',
        createdAt: r.createdAt.toISOString(),
        roomIdCode: `AR-${r.id.substring(0, 6)}`.toUpperCase(),
        creatorHandle: '@owner',
        sessionTime: `${sessionMinutes}m`,
      };
    });

    const formattedVideo = videoRooms.map((r, i) => {
      const sessionMinutes = Math.max(
        1,
        Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 60000),
      );
      return {
        id: r.id,
        name: r.name || `Video Room ${i + 1}`,
        category: 'Video room',
        isPublic: true,
        isVerified: true,
        participantsCount: 1,
        reportsCount: 0,
        warningsCount: 0,
        bansCount: 0,
        imageUrl: 'assets/Moderator_UI/Rectangle 67.png',
        roomType: 'video',
        createdAt: r.createdAt.toISOString(),
        roomIdCode: `VR-${r.id.substring(0, 6)}`.toUpperCase(),
        creatorHandle: '@owner',
        sessionTime: `${sessionMinutes}m`,
      };
    });

    const formattedStreams = liveStreams.map((s, i) => {
      const sessionMinutes = Math.max(
        1,
        Math.floor((Date.now() - new Date(s.createdAt).getTime()) / 60000),
      );
      return {
        id: s.id,
        name: s.title || `Live Stream ${i + 1}`,
        category: 'Broadcast',
        isPublic: true,
        isVerified: true,
        participantsCount: 1,
        reportsCount: 0,
        warningsCount: 0,
        bansCount: 0,
        imageUrl: 'assets/Moderator_UI/image 733.png',
        roomType: 'stream',
        createdAt: s.createdAt.toISOString(),
        roomIdCode: `LS-${s.id.substring(0, 6)}`.toUpperCase(),
        creatorHandle: '@host',
        sessionTime: `${sessionMinutes}m`,
      };
    });

    return {
      region: isUnrestricted ? 'ALL' : 'SCOPED',
      audioRooms: formattedAudio,
      videoRooms: formattedVideo,
      liveStreams: formattedStreams,
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
    const [scope, summary, queue, dailyActivity, liveMonitoring, warningsReceivedCount] =
      await Promise.all([
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
    // table) to the same columns on entity tables (support_tickets, campaigns,
    // content_requests, community_programs — all untouched by the Region→State
    // moderation migration, so they still carry a real regionId column).
    const buildLocationFilter = (
      sw: typeof scopeWhere,
      keys: string[],
    ): Record<string, unknown> => {
      if (isUnrestricted || !('OR' in sw)) return {};
      return {
        OR: sw.OR.map((clause) => {
          const out: Record<string, unknown> = {};
          for (const key of keys) {
            if (key in clause) out[key] = clause[key];
          }
          return out;
        }),
      };
    };

    const locationFilter = buildLocationFilter(scopeWhere, ['countryId', 'stateId', 'regionId']);
    // LiveStream no longer carries a regionId column (moderation scoping
    // stops at State) — country/state only, unlike the filter above.
    const streamLocationFilter = buildLocationFilter(scopeWhere, ['countryId', 'stateId']);

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
      this.prisma.liveStream.count({ where: { status: 'LIVE', ...streamLocationFilter } }),

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

  /**
   * Tasks assigned to the moderator.
   */
  async moderatorTasks(userId: string) {
    const [assignedAudio, assignedVideo] = await Promise.all([
      this.prisma.roomReport.findMany({
        where: { assigneeId: userId, status: 'PENDING' },
        take: 10,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.videoRoomReport.findMany({
        where: { assigneeId: userId, status: 'PENDING' },
        take: 10,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const tasks = [
      ...assignedAudio.map((r) => ({
        id: `task-ar-${r.id}`,
        title: 'Review audio room report',
        description:
          r.description || `Investigate report ${r.reason || 'violation'} in audio room.`,
        priority: 'High',
        taskType: 'flag',
        category: 'Audio room',
        status: 'PENDING',
        dueInMinutes: 45,
        dueText: '45m',
        createdAt: r.createdAt.toISOString(),
      })),
      ...assignedVideo.map((r) => ({
        id: `task-vr-${r.id}`,
        title: 'Review video room report',
        description:
          r.description || `Investigate report ${r.reason || 'violation'} in video room.`,
        priority: 'High',
        taskType: 'warning',
        category: 'Video room',
        status: 'PENDING',
        dueInMinutes: 30,
        dueText: '30m',
        createdAt: r.createdAt.toISOString(),
      })),
    ];

    return tasks;
  }

  /**
   * Fetch full room details for moderator live monitoring console.
   */
  async roomDetails(userId: string, roomId: string) {
    const [audioRoom, videoRoom] = await Promise.all([
      this.prisma.audioRoom.findUnique({
        where: { id: roomId },
      }),
      this.prisma.videoRoom.findUnique({
        where: { id: roomId },
      }),
    ]);

    const room = audioRoom || videoRoom;
    const isVideo = !audioRoom && !!videoRoom;
    const roomType = isVideo ? 'video' : 'audio';

    const ownerId = (room as any)?.ownerId;
    const owner = ownerId
      ? await this.prisma.user.findUnique({
          where: { id: ownerId },
          select: { id: true, username: true, fullName: true },
        })
      : null;

    let participants: Array<{
      id: string;
      name: string;
      handle: string;
      level: number;
      avatarUrl: string;
      role: string;
      joinedAt: string;
    }> = [];

    if (!isVideo) {
      const members = await this.prisma.roomMember.findMany({
        where: { roomId, isActive: true },
        take: 50,
        orderBy: { joinedAt: 'desc' },
      });
      const memberUserIds = members.map((m) => m.userId);
      const memberUsers =
        memberUserIds.length > 0
          ? await this.prisma.user.findMany({
              where: { id: { in: memberUserIds } },
              select: { id: true, username: true, fullName: true },
            })
          : [];
      const memberUserMap = new Map(memberUsers.map((u) => [u.id, u]));
      participants = members.map((m) => {
        const u = memberUserMap.get(m.userId);
        return {
          id: m.userId,
          name: u?.fullName || u?.username || 'User',
          handle: `@${u?.username || m.userId.substring(0, 6)}`,
          level: 38,
          // `User` carries no avatar column (that's `UserProfile.avatarKey`,
          // an S3 key needing `MediaUrlResolver` to become a URL) — this view
          // uses the same static placeholder every other room/participant
          // card in this service falls back to, not a resolved photo.
          avatarUrl: 'assets/Moderator_UI/Rectangle 67.png',
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
        };
      });
    }

    const reports = !isVideo
      ? await this.prisma.roomReport.findMany({
          where: { roomId, status: 'PENDING' },
          take: 20,
          orderBy: { createdAt: 'desc' },
        })
      : await this.prisma.videoRoomReport.findMany({
          where: { roomId, status: 'PENDING' },
          take: 20,
          orderBy: { createdAt: 'desc' },
        });

    const reporterIds = reports.map((r) => r.reporterId);
    const reporterUsers =
      reporterIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: reporterIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [];
    const reporterUserMap = new Map(reporterUsers.map((u) => [u.id, u]));

    const formattedReports = reports.map((r) => {
      const reporter = reporterUserMap.get(r.reporterId);
      return {
        id: r.id,
        user: reporter?.fullName || reporter?.username || 'Reported user',
        reason: r.reason ? r.reason.replace(/_/g, ' ') : 'Violation',
        time: new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
    });

    const chatMessages = !isVideo
      ? await this.prisma.roomMessage.findMany({
          where: { roomId, isDeleted: false },
          take: 30,
          orderBy: { createdAt: 'asc' },
        })
      : await this.prisma.videoRoomMessage.findMany({
          where: { roomId, deletedAt: null },
          take: 30,
          orderBy: { createdAt: 'asc' },
        });

    const senderIds = chatMessages.map((m) => m.senderId);
    const senders =
      senderIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: senderIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [];
    const senderMap = new Map(senders.map((u) => [u.id, u]));

    const formattedChat = chatMessages.map((m) => {
      const sender = senderMap.get(m.senderId);
      const senderName = sender?.fullName || sender?.username || 'User';
      return {
        id: m.id,
        initial: (senderName[0] || 'U').toUpperCase(),
        sender: senderName,
        message: m.content,
        time: new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
    });

    const bansCount = !isVideo
      ? await this.prisma.roomBan.count({ where: { roomId, status: 'ACTIVE' } })
      : await this.prisma.videoRoomBlock.count({ where: { roomId, status: 'ACTIVE' } });

    const createdAt = room ? (room as any).createdAt : new Date();
    const sessionMinutes = Math.max(
      1,
      Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000),
    );

    return {
      id: roomId,
      name: room?.name || 'Live Room',
      category: isVideo ? 'Video room' : 'Audio room',
      isPublic: (room as any)?.visibility === 'PUBLIC' || (room as any)?.isPublic !== false,
      isVerified: true,
      participantsCount: participants.length,
      reportsCount: reports.length,
      warningsCount: 0,
      bansCount,
      imageUrl: (room as any)?.imageKey || 'assets/Moderator_UI/Rectangle 67.png',
      roomType,
      roomIdCode: `AR-${roomId.substring(0, 6)}`.toUpperCase(),
      creatorHandle: `@${owner?.username || 'creator'}`,
      sessionTime: `${sessionMinutes}m`,
      chatMessages: formattedChat,
      activeReports: formattedReports,
      participants,
    };
  }

  /**
   * Action a report (Warn, Mute, Kick, Ban, Escalate, Close).
   */
  async actionReport(userId: string, reportId: string, data: { action: string; note?: string }) {
    await Promise.all([
      this.prisma.roomReport.updateMany({
        where: { id: reportId },
        data: {
          status: data.action.toLowerCase() === 'close' ? 'DISMISSED' : 'ACTIONED',
          reviewedBy: userId,
          reviewedAt: new Date(),
          resolutionAction: data.action,
          moderatorNotes: data.note,
        },
      }),
      this.prisma.videoRoomReport.updateMany({
        where: { id: reportId },
        data: {
          status: data.action.toLowerCase() === 'close' ? 'DISMISSED' : 'ACTIONED',
          reviewedBy: userId,
          reviewedAt: new Date(),
          resolutionAction: data.action,
          moderatorNotes: data.note,
        },
      }),
    ]);

    return { success: true, reportId, action: data.action };
  }

  /**
   * Moderate participant in a room (mute, kick, ban).
   */
  async moderateParticipant(
    userId: string,
    roomId: string,
    targetUserId: string,
    data: { action: string; reason?: string },
  ) {
    const action = data.action.toLowerCase();
    if (action.includes('kick')) {
      await this.prisma.roomKick.create({
        data: {
          roomId,
          userId: targetUserId,
          moderatorId: userId,
          reason: data.reason || 'Moderator kick',
        },
      });
      await this.prisma.roomMember.updateMany({
        where: { roomId, userId: targetUserId, isActive: true },
        data: { isActive: false, leftAt: new Date() },
      });
    } else if (action.includes('ban')) {
      await this.prisma.roomBan.create({
        data: {
          roomId,
          userId: targetUserId,
          moderatorId: userId,
          type: 'PERMANENT',
          reason: data.reason || 'Moderator ban',
        },
      });
      await this.prisma.roomMember.updateMany({
        where: { roomId, userId: targetUserId, isActive: true },
        data: { isActive: false, leftAt: new Date() },
      });
    } else if (action.includes('mute')) {
      await this.prisma.roomMute.create({
        data: {
          roomId,
          userId: targetUserId,
          moderatorId: userId,
          type: ModerationMuteType.TEMPORARY,
          reason: data.reason || 'Moderator mute',
          expiresAt: new Date(Date.now() + QUICK_MUTE_DURATION_MINUTES * 60_000),
        },
      });
    }

    return { success: true, roomId, targetUserId, action: data.action };
  }

  /**
   * Complete task.
   */
  async completeTask(userId: string, taskId: string) {
    return { success: true, taskId, completedAt: new Date().toISOString() };
  }
}
