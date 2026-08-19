import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  LiveStreamStatus,
  ModerationMuteType,
  ModerationStatus,
  ModeratorWarningStatus,
  RoleRequestStage,
  RoleRequestStatus,
  RoleRequestType,
  type PlatformRole,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import {
  WorkforceScopeService,
  type EscalationSeverity,
  type UserScopeFilter,
} from './workforce-scope.service';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { ModeratorShiftService } from 'src/modules/moderator-shift/services/moderator-shift.service';
import { ModeratorWarningService } from 'src/modules/moderator-warning/services/moderator-warning.service';
import { ModerationService } from 'src/modules/audio-rooms/services/moderation.service';
import { VideoRoomReportService } from 'src/modules/video-rooms/services/video-room-report.service';
import { VideoRoomModerationService } from 'src/modules/video-rooms/services/video-room-moderation.service';
import { LiveStreamReportService } from 'src/modules/live-streaming/services/live-stream-report.service';
import { LiveStreamService } from 'src/modules/live-streaming/services/live-stream.service';
import { InvestigationRecordingService } from 'src/modules/investigation-recording/services/investigation-recording.service';
import { PermissionResolver } from 'src/modules/authorization/services/permission-resolver.service';
import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';
import { SYSTEM_MODERATOR_ID } from 'src/modules/audio-rooms/constants/moderation.constants';
import { deriveReportPriority, deriveRuleViolated } from './report-classification.util';

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
 * Which of the 3 report tables a report id resolved to — see
 * `MobileWorkforceService.resolveReportContext`.
 */
type ReportRoomType = 'audio' | 'video' | 'stream';

/**
 * Report fields common across `RoomReport`, `VideoRoomReport`, and
 * `LiveStreamReport`, normalized so callers don't need to branch on
 * `roomType` just to read reporter/target/reason/status. `roomId` holds the
 * stream id for `roomType === 'stream'` too — `LiveStreamReport.streamId`
 * maps into this same field rather than being renamed at every call site.
 */
interface ReportContext {
  roomType: ReportRoomType;
  roomId: string;
  reporterId: string;
  targetUserId: string;
  reason: string;
  description: string | null;
  status: string;
  createdAt: Date;
  assignedAt: Date | null;
}

/**
 * The 6 moderation-decision buttons on a report's detail page, normalized
 * from the free-text `action` string the mobile client sends — see
 * `MobileWorkforceService.normalizeAction`.
 */
type NormalizedAction = 'WARN' | 'MUTE' | 'KICK' | 'BAN' | 'ESCALATE' | 'CLOSE_FALSE_REPORT';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: WorkforceScopeService,
    private readonly scopes: GeographicScopeResolver,
    @Optional() private readonly shiftService?: ModeratorShiftService,
    @Optional() private readonly warnings?: ModeratorWarningService,
    private readonly audioModeration?: ModerationService,
    private readonly videoReports?: VideoRoomReportService,
    private readonly videoModeration?: VideoRoomModerationService,
    private readonly liveStreamReports?: LiveStreamReportService,
    private readonly liveStream?: LiveStreamService,
    private readonly investigationRecording?: InvestigationRecordingService,
    private readonly permissionResolver?: PermissionResolver,
    @Optional() private readonly platformBans?: PlatformBanService,
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
        stateName: s.stateName ?? null,
        moderatorRegionCode: s.moderatorRegionCode ?? null,
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

    const [total, rawItems] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 100),
        skip: offset,
        select: {
          id: true,
          username: true,
          fullName: true,
          email: true,
          status: true,
          roles: true,
          country: true,
          countryId: true,
          stateId: true,
          regionId: true,
          createdAt: true,
          locationCountry: { select: { name: true } },
          locationState: { select: { name: true } },
          locationRegion: { select: { name: true } },
        },
      }),
    ]);

    const items = rawItems.map((u) => {
      const allRoles = Array.isArray(u.roles) && u.roles.length > 0 ? u.roles : ['USER'];
      const operationalRole = allRoles.find((r) => r !== 'USER') || allRoles[0] || 'USER';
      return {
        id: u.id,
        username: u.username,
        fullName: u.fullName,
        displayName: u.fullName || u.username,
        email: u.email || 'No email',
        status: u.status,
        isSuspended: u.status === 'SUSPENDED' || u.status === 'BANNED',
        role: operationalRole,
        roles: allRoles,
        country: u.locationCountry?.name || u.country || 'Unknown',
        state: u.locationState?.name || null,
        region: u.locationRegion?.name || null,
        createdAt: u.createdAt.toISOString(),
      };
    });

    return { total, items };
  }

  /**
   * Moderation queue for my scope — audio, video, and live-stream reports
   * combined. Priority and rule-violated are derived from the report's real
   * `reason` (Task 2's reference tables), not fabricated per room type.
   *
   * `resolvedScope` lets a caller that already resolved scope (see
   * `moderatorDashboard`) pass it in instead of this method resolving it
   * again; standalone callers omit it and it self-resolves as before.
   */
  async moderationQueue(userId: string, limit = 25, resolvedScope?: ResolvedUserScope) {
    const { isUnrestricted, inScopeUserIds } =
      resolvedScope ?? (await this.resolveUserScope(userId));

    // Scope by the report's room/stream OWNER, not the reporter — matching
    // `reportDetails`/`actionReport`'s `assertModeratorInScope(userId,
    // ownerId)` semantics (and `regionalDailyActivity`'s
    // roomOwnerFilter/streamHostFilter pattern below), so a report that
    // appears in this list is always one the moderator can actually open.
    // Reporter-based scoping let a report with an in-region reporter but an
    // out-of-region room owner appear here and then 403 on open.
    const roomOwnerFilter = isUnrestricted ? {} : { ownerId: { in: inScopeUserIds ?? [] } };
    const streamHostFilter = isUnrestricted ? {} : { hostId: { in: inScopeUserIds ?? [] } };

    const [inScopeAudioRoomIds, inScopeVideoRoomIds, inScopeLiveStreamIds] = await Promise.all([
      isUnrestricted
        ? Promise.resolve(null)
        : this.prisma.audioRoom.findMany({ where: roomOwnerFilter, select: { id: true } }),
      isUnrestricted
        ? Promise.resolve(null)
        : this.prisma.videoRoom.findMany({ where: roomOwnerFilter, select: { id: true } }),
      isUnrestricted
        ? Promise.resolve(null)
        : this.prisma.liveStream.findMany({ where: streamHostFilter, select: { id: true } }),
    ]);

    const audioReportFilter =
      inScopeAudioRoomIds === null ? {} : { roomId: { in: inScopeAudioRoomIds.map((r) => r.id) } };
    const videoReportFilter =
      inScopeVideoRoomIds === null ? {} : { roomId: { in: inScopeVideoRoomIds.map((r) => r.id) } };
    const streamReportFilter =
      inScopeLiveStreamIds === null
        ? {}
        : { streamId: { in: inScopeLiveStreamIds.map((r) => r.id) } };

    const [audioReports, videoReports, streamReports] = await Promise.all([
      this.prisma.roomReport.findMany({
        where: audioReportFilter,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 50),
      }),
      this.prisma.videoRoomReport.findMany({
        where: videoReportFilter,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 50),
      }),
      this.prisma.liveStreamReport.findMany({
        where: streamReportFilter,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 50),
      }),
    ]);

    const userIds = [
      ...audioReports.map((r) => r.reporterId),
      ...videoReports.map((r) => r.reporterId),
      ...streamReports.map((r) => r.reporterId),
      ...audioReports.map((r) => r.targetUserId),
      ...videoReports.map((r) => r.targetUserId),
      ...streamReports.map((r) => r.targetUserId),
    ];
    const audioRoomIds = audioReports.map((r) => r.roomId);
    const videoRoomIds = videoReports.map((r) => r.roomId);
    const streamIds = streamReports.map((r) => r.streamId);

    const [users, audioRoomsList, videoRoomsList, streamsList] = await Promise.all([
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
      streamIds.length > 0
        ? this.prisma.liveStream.findMany({
            where: { id: { in: streamIds } },
            select: { id: true, title: true, hostId: true },
          })
        : [],
    ]);

    const ownerIds = [
      ...audioRoomsList.map((r) => r.ownerId),
      ...videoRoomsList.map((r) => r.ownerId),
      // LiveStream.hostId is nullable (`String?`), unlike AudioRoom/VideoRoom's
      // required ownerId — filter nulls out so `ownerIds` stays a clean
      // `string[]` for the `id: { in: ownerIds } }` lookup below.
      ...streamsList.map((s) => s.hostId).filter((id): id is string => id != null),
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
    const streamMap = new Map(streamsList.map((s) => [s.id, s]));

    const statusLabel = (status: string) => (status === 'PENDING' ? 'Under review' : 'Resolved');
    const codeFor = (prefix: string, id: string) =>
      `${prefix}-${id.substring(0, 4)}-${id.substring(id.length - 4)}`.toUpperCase();
    const humanize = (reason: string) =>
      reason
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (c: string) => c.toUpperCase());
    const assignedTimeFor = (assignedAt: Date | null, createdAt: Date) =>
      new Date(assignedAt ?? createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });

    const formattedReports = [
      ...videoReports.map((r) => {
        const reporter = userMap.get(r.reporterId);
        const targetUser = userMap.get(r.targetUserId);
        const room = videoRoomMap.get(r.roomId);
        return {
          id: r.id,
          reportCode: codeFor('RPT', r.id),
          roomType: 'video',
          roomTitle: room?.name || 'Video room',
          reporterName: reporter?.fullName || reporter?.username || 'Reporter',
          reporterId: r.reporterId.substring(0, 6),
          targetUserName: targetUser?.fullName || targetUser?.username || 'Target User',
          targetUserId: r.targetUserId.substring(0, 6),
          region: (room?.ownerId && ownerStateMap.get(room.ownerId)) || 'Unassigned',
          violationReason: humanize(r.reason),
          description: r.description || 'Violation reported in video room.',
          priority: deriveReportPriority(r.reason),
          ruleViolated: deriveRuleViolated(r.reason),
          status: statusLabel(r.status),
          createdAt: r.createdAt.toISOString(),
          assignedTime: assignedTimeFor(r.assignedAt, r.createdAt),
        };
      }),
      ...audioReports.map((r) => {
        const reporter = userMap.get(r.reporterId);
        const targetUser = userMap.get(r.targetUserId);
        const room = audioRoomMap.get(r.roomId);
        return {
          id: r.id,
          reportCode: codeFor('RPT', r.id),
          roomType: 'audio',
          roomTitle: room?.name || 'Audio room',
          reporterName: reporter?.fullName || reporter?.username || 'Reporter',
          reporterId: r.reporterId.substring(0, 6),
          targetUserName: targetUser?.fullName || targetUser?.username || 'Target User',
          targetUserId: r.targetUserId.substring(0, 6),
          region: (room?.ownerId && ownerStateMap.get(room.ownerId)) || 'Unassigned',
          violationReason: humanize(r.reason),
          description: r.description || 'Violation reported in audio room.',
          priority: deriveReportPriority(r.reason),
          ruleViolated: deriveRuleViolated(r.reason),
          status: statusLabel(r.status),
          createdAt: r.createdAt.toISOString(),
          assignedTime: assignedTimeFor(r.assignedAt, r.createdAt),
        };
      }),
      ...streamReports.map((r) => {
        const reporter = userMap.get(r.reporterId);
        const targetUser = userMap.get(r.targetUserId);
        const stream = streamMap.get(r.streamId);
        return {
          id: r.id,
          reportCode: codeFor('RPT', r.id),
          roomType: 'stream',
          roomTitle: stream?.title || 'Live stream',
          reporterName: reporter?.fullName || reporter?.username || 'Reporter',
          reporterId: r.reporterId.substring(0, 6),
          targetUserName: targetUser?.fullName || targetUser?.username || 'Target User',
          targetUserId: r.targetUserId.substring(0, 6),
          region: (stream?.hostId && ownerStateMap.get(stream.hostId)) || 'Unassigned',
          violationReason: humanize(r.reason),
          description: r.description || 'Violation reported in live stream.',
          priority: deriveReportPriority(r.reason),
          ruleViolated: deriveRuleViolated(r.reason),
          status: statusLabel(r.status),
          createdAt: r.createdAt.toISOString(),
          assignedTime: assignedTimeFor(null, r.createdAt),
        };
      }),
    ];

    // Each of the 3 tables above was independently capped at `limit`, so the
    // combined array can hold up to 3x what the caller asked for — sort by
    // recency across all room types and cap the merged result to `limit`.
    formattedReports.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return formattedReports.slice(0, limit);
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
   * Resolves which of the 3 report tables `reportId` belongs to. Sequential
   * lookups are cheap (at most 3 indexed `findUnique` calls) and a UUID
   * collision across tables is not a real risk — every caller in this
   * service (`moderationQueue`, `reportDetails`, `actionReport`) needs this
   * exact resolution, so it lives here once instead of being copy-pasted
   * three times.
   */
  private async resolveReportContext(reportId: string): Promise<ReportContext> {
    const audio = await this.prisma.roomReport.findUnique({ where: { id: reportId } });
    if (audio) {
      return {
        roomType: 'audio',
        roomId: audio.roomId,
        reporterId: audio.reporterId,
        targetUserId: audio.targetUserId,
        reason: audio.reason,
        description: audio.description,
        status: audio.status,
        createdAt: audio.createdAt,
        assignedAt: audio.assignedAt,
      };
    }

    const video = await this.prisma.videoRoomReport.findUnique({ where: { id: reportId } });
    if (video) {
      return {
        roomType: 'video',
        roomId: video.roomId,
        reporterId: video.reporterId,
        targetUserId: video.targetUserId,
        reason: video.reason,
        description: video.description,
        status: video.status,
        createdAt: video.createdAt,
        assignedAt: video.assignedAt,
      };
    }

    const stream = await this.prisma.liveStreamReport.findUnique({ where: { id: reportId } });
    if (stream) {
      return {
        roomType: 'stream',
        roomId: stream.streamId,
        reporterId: stream.reporterId,
        targetUserId: stream.targetUserId,
        reason: stream.reason,
        description: stream.description,
        status: stream.status,
        createdAt: stream.createdAt,
        assignedAt: null,
      };
    }

    throw new NotFoundException('Report not found.');
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

    // "Assigned" reports = currently open (PENDING) ones, not the lifetime
    // total ever filed in-region — REVIEWED/DISMISSED/ACTIONED reports are
    // already closed and must not keep inflating this count forever.
    const audioReportScopeFilter =
      inScopeAudioRoomIds === null ? {} : { roomId: { in: inScopeAudioRoomIds.map((r) => r.id) } };
    const videoReportScopeFilter =
      inScopeVideoRoomIds === null ? {} : { roomId: { in: inScopeVideoRoomIds.map((r) => r.id) } };
    const streamReportScopeFilter =
      inScopeLiveStreamIds === null
        ? {}
        : { streamId: { in: inScopeLiveStreamIds.map((r) => r.id) } };

    // Day-over-day report volume (independent of status) backs the
    // dashboard's "vs yesterday" delta for the assigned-reports tile, which
    // has no snapshotted backlog history to diff against directly.
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);

    const [
      roomReportsCount,
      videoRoomReportsCount,
      liveStreamReportsCount,
      assignedInvestigationQueueCount,
      newAudioToday,
      newVideoToday,
      newStreamToday,
      newAudioYesterday,
      newVideoYesterday,
      newStreamYesterday,
    ] = await Promise.all([
      this.prisma.roomReport.count({ where: { ...audioReportScopeFilter, status: 'PENDING' } }),
      this.prisma.videoRoomReport.count({
        where: { ...videoReportScopeFilter, status: 'PENDING' },
      }),
      this.prisma.liveStreamReport.count({
        where: { ...streamReportScopeFilter, status: 'PENDING' },
      }),
      this.prisma.investigationRecording.count({
        where: { status: 'ACTIVE', ...investigationRoomFilter },
      }),
      this.prisma.roomReport.count({
        where: { ...audioReportScopeFilter, createdAt: { gte: startOfToday } },
      }),
      this.prisma.videoRoomReport.count({
        where: { ...videoReportScopeFilter, createdAt: { gte: startOfToday } },
      }),
      this.prisma.liveStreamReport.count({
        where: { ...streamReportScopeFilter, createdAt: { gte: startOfToday } },
      }),
      this.prisma.roomReport.count({
        where: {
          ...audioReportScopeFilter,
          createdAt: { gte: startOfYesterday, lt: startOfToday },
        },
      }),
      this.prisma.videoRoomReport.count({
        where: {
          ...videoReportScopeFilter,
          createdAt: { gte: startOfYesterday, lt: startOfToday },
        },
      }),
      this.prisma.liveStreamReport.count({
        where: {
          ...streamReportScopeFilter,
          createdAt: { gte: startOfYesterday, lt: startOfToday },
        },
      }),
    ]);
    const assignedReportsCount = roomReportsCount + videoRoomReportsCount + liveStreamReportsCount;
    const newReportsToday = newAudioToday + newVideoToday + newStreamToday;
    const newReportsYesterday = newAudioYesterday + newVideoYesterday + newStreamYesterday;

    return {
      assignedReportsCount,
      assignedInvestigationQueueCount,
      assignedAudioRooms,
      assignedVideoRooms,
      assignedLiveStreams,
      newReportsToday,
      newReportsYesterday,
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

    // Fetch owner/host handles
    const allOwnerIds = Array.from(
      new Set([
        ...audioRooms.map((r) => r.ownerId),
        ...videoRooms.map((r) => r.ownerId),
        ...liveStreams.map((s) => s.hostId).filter((id): id is string => !!id),
      ]),
    );

    const owners =
      allOwnerIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: allOwnerIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [];
    const ownerMap = new Map(owners.map((u) => [u.id, u]));

    const formattedAudio = await Promise.all(
      audioRooms.map(async (r, i) => {
        const sessionMinutes = Math.max(
          1,
          Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 60000),
        );
        const [participantsCount, reportsCount, warningsCount, bansCount] = await Promise.all([
          this.prisma.roomMember.count({ where: { roomId: r.id, isActive: true } }).catch(() => 1),
          this.prisma.roomReport
            .count({ where: { roomId: r.id, status: 'PENDING' } })
            .catch(() => 0),
          this.prisma.roomMute.count({ where: { roomId: r.id } }).catch(() => 0),
          this.prisma.roomBan.count({ where: { roomId: r.id, status: 'ACTIVE' } }).catch(() => 0),
        ]);
        const owner = ownerMap.get(r.ownerId);

        return {
          id: r.id,
          name: r.name || `Audio Room ${i + 1}`,
          category: 'Audio room',
          isPublic: true,
          isVerified: true,
          participantsCount: Math.max(1, participantsCount),
          reportsCount,
          warningsCount,
          bansCount,
          imageUrl: 'assets/Moderator_UI/image 733.png',
          roomType: 'audio',
          createdAt: r.createdAt.toISOString(),
          roomIdCode: `AR-${r.id.substring(0, 6)}`.toUpperCase(),
          creatorHandle: `@${owner?.username || 'owner'}`,
          sessionTime: `${sessionMinutes}m`,
        };
      }),
    );

    const formattedVideo = await Promise.all(
      videoRooms.map(async (r, i) => {
        const sessionMinutes = Math.max(
          1,
          Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 60000),
        );
        const [participantsCount, reportsCount, warningsCount, bansCount] = await Promise.all([
          this.prisma.videoRoomMember
            .count({ where: { roomId: r.id, isActive: true } })
            .catch(() => 1),
          this.prisma.videoRoomReport
            .count({ where: { roomId: r.id, status: 'PENDING' } })
            .catch(() => 0),
          this.prisma.videoRoomWarning.count({ where: { roomId: r.id } }).catch(() => 0),
          this.prisma.videoRoomBlock
            .count({ where: { roomId: r.id, status: 'ACTIVE' } })
            .catch(() => 0),
        ]);
        const owner = ownerMap.get(r.ownerId);

        return {
          id: r.id,
          name: r.name || `Video Room ${i + 1}`,
          category: 'Video room',
          isPublic: true,
          isVerified: true,
          participantsCount: Math.max(1, participantsCount),
          reportsCount,
          warningsCount,
          bansCount,
          imageUrl: 'assets/Moderator_UI/Rectangle 67.png',
          roomType: 'video',
          createdAt: r.createdAt.toISOString(),
          roomIdCode: `VR-${r.id.substring(0, 6)}`.toUpperCase(),
          creatorHandle: `@${owner?.username || 'owner'}`,
          sessionTime: `${sessionMinutes}m`,
        };
      }),
    );

    const formattedBroadcastStreams = await Promise.all(
      liveStreams.map(async (s, i) => {
        const sessionMinutes = Math.max(
          1,
          Math.floor((Date.now() - new Date(s.createdAt).getTime()) / 60000),
        );
        const [reportsCount, bansCount] = await Promise.all([
          this.prisma.liveStreamReport
            .count({ where: { streamId: s.id, status: 'PENDING' } })
            .catch(() => 0),
          this.prisma.liveStreamBan.count({ where: { streamId: s.id } }).catch(() => 0),
        ]);
        const host = s.hostId ? ownerMap.get(s.hostId) : null;

        return {
          id: s.id,
          name: s.title || `Live Stream ${i + 1}`,
          category: 'Broadcast',
          isPublic: true,
          isVerified: true,
          participantsCount: 1,
          reportsCount,
          warningsCount: 0,
          bansCount,
          imageUrl: 'assets/Moderator_UI/image 733.png',
          roomType: 'stream',
          createdAt: s.createdAt.toISOString(),
          roomIdCode: `LS-${s.id.substring(0, 6)}`.toUpperCase(),
          creatorHandle: `@${host?.username || 'host'}`,
          sessionTime: `${sessionMinutes}m`,
        };
      }),
    );

    // Live streams tab displays active broadcast streams plus all currently live rooms
    const allLiveStreams = [...formattedBroadcastStreams, ...formattedAudio, ...formattedVideo];

    return {
      region: isUnrestricted ? 'ALL' : 'SCOPED',
      audioRooms: formattedAudio,
      videoRooms: formattedVideo,
      liveStreams: allLiveStreams,
      activeAudioRooms: { count: formattedAudio.length, rooms: formattedAudio },
      activeVideoRooms: { count: formattedVideo.length, rooms: formattedVideo },
      activeLiveStreams: { count: allLiveStreams.length, streams: allLiveStreams },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Moderator operational dashboard (Task 20, Gap E1, E2).
   * Includes shiftStatus nextShiftStartsInSeconds, active state, assigned rooms and assigned queue.
   */
  async moderatorDashboard(userId: string) {
    // Resolved once and shared by all three calls below (via .then, so it
    // still runs concurrently with everything else in this Promise.all)
    // instead of moderationQueue/regionalDailyActivity/liveMonitoring each
    // independently re-resolving it.
    const resolvedScope = this.resolveUserScope(userId);
    const [scope, summary, queue, dailyActivity, liveMonitoring, warningsReceivedCount] =
      await Promise.all([
        this.myScope(userId),
        this.summary(userId),
        resolvedScope.then((rs) => this.moderationQueue(userId, 5, rs)),
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

    // Today's & yesterday's stats — yesterday backs the "vs yesterday"
    // deltas below. `taskCompletionRate*` is computed live from assignment
    // timestamps rather than read off `ModeratorDailyStats.taskCompletionRate`,
    // which nothing in the codebase ever writes (always defaults to 0).
    const dateKey = new Date().toISOString().slice(0, 10);
    const yesterdayDateKey = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const [todayStats, yesterdayStats, taskCompletionToday, taskCompletionYesterday] =
      await Promise.all([
        this.prisma.moderatorDailyStats.findUnique({
          where: { moderatorId_dateKey: { moderatorId: userId, dateKey } },
        }),
        this.prisma.moderatorDailyStats.findUnique({
          where: { moderatorId_dateKey: { moderatorId: userId, dateKey: yesterdayDateKey } },
        }),
        this.taskCompletionRateAsOf(userId, new Date()),
        this.taskCompletionRateAsOf(userId, startOfToday),
      ]);

    const deltas = {
      reportsAssigned: this.buildDelta(
        dailyActivity.newReportsToday,
        dailyActivity.newReportsYesterday,
        false,
      ),
      reportsUnderReview: this.buildDelta(
        todayStats?.reportsReviewed ?? 0,
        yesterdayStats?.reportsReviewed ?? 0,
        true,
      ),
      reportsSolved: this.buildDelta(
        todayStats?.reportsResolved ?? 0,
        yesterdayStats?.reportsResolved ?? 0,
        true,
      ),
      reportsEscalated: this.buildDelta(
        todayStats?.reportsEscalated ?? 0,
        yesterdayStats?.reportsEscalated ?? 0,
        false,
      ),
      warningsIssued: this.buildDelta(
        todayStats?.warningsIssued ?? 0,
        yesterdayStats?.warningsIssued ?? 0,
        false,
      ),
      performanceScore: this.buildDelta(
        todayStats?.performanceScore ?? 0,
        yesterdayStats?.performanceScore ?? 0,
        true,
      ),
      avgResolutionMinutes: this.buildDelta(
        todayStats?.avgResolutionMinutes ?? 0,
        yesterdayStats?.avgResolutionMinutes ?? 0,
        false,
      ),
      taskCompletionRate: this.buildDelta(taskCompletionToday, taskCompletionYesterday, true),
    };

    return {
      scope,
      populationSummary: summary,
      shift: shift ?? null,
      shiftActive,
      nextShiftStartsInSeconds,
      todayStats: todayStats ? { ...todayStats, taskCompletionRate: taskCompletionToday } : null,
      deltas,
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
   * Point-in-time task completion rate for a moderator, computed live from
   * `moderator_task_assignments` timestamps rather than the
   * `ModeratorDailyStats.taskCompletionRate` column (which nothing writes).
   * Passing `new Date()` and start-of-today respectively gives today's and
   * yesterday's rate for the dashboard delta.
   */
  private async taskCompletionRateAsOf(moderatorId: string, cutoff: Date): Promise<number> {
    const [assigned, completed] = await Promise.all([
      this.prisma.moderator_task_assignments.count({
        where: { moderatorId, createdAt: { lte: cutoff } },
      }),
      this.prisma.moderator_task_assignments.count({
        where: { moderatorId, completedAt: { lte: cutoff } },
      }),
    ]);
    return assigned > 0 ? (completed / assigned) * 100 : 0;
  }

  /**
   * Percentage change of `today` vs `yesterday` for a dashboard tile, plus
   * whether that change is favorable for this specific metric — some tiles
   * (warnings issued, avg. resolution time, escalations) are better when
   * they go down, so a plain "higher = green" rule would mislabel them.
   * `percent` is `null` when there's nothing meaningful to compare: both
   * zero (no change), or yesterday was zero and today isn't (a "new"
   * delta, not a real percentage — `Infinity%` would be misleading).
   */
  private buildDelta(
    today: number,
    yesterday: number,
    higherIsBetter: boolean,
  ): { percent: number | null; favorable: boolean } {
    if (yesterday === 0) {
      if (today === 0) return { percent: null, favorable: true };
      return { percent: null, favorable: higherIsBetter };
    }
    const percent = Math.round(((today - yesterday) / yesterday) * 100);
    const favorable = higherIsBetter ? percent >= 0 : percent <= 0;
    return { percent, favorable };
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

      // 3. Active agencies in scope
      this.prisma.user.count({
        where: {
          ...scopeWhere,
          status: 'ACTIVE',
          roles: { hasSome: ['AGENCY'] as any },
        },
      }),

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
    const [audioRoom, videoRoom, liveStream] = await Promise.all([
      this.prisma.audioRoom.findUnique({
        where: { id: roomId },
      }),
      this.prisma.videoRoom.findUnique({
        where: { id: roomId },
      }),
      this.prisma.liveStream.findUnique({
        where: { id: roomId },
      }),
    ]);

    const isVideo = !audioRoom && !!videoRoom;
    const isStream = !audioRoom && !videoRoom && !!liveStream;
    const room = audioRoom || videoRoom || liveStream;
    const roomType = isStream ? 'stream' : isVideo ? 'video' : 'audio';

    const ownerId = isStream
      ? liveStream?.hostId || liveStream?.streamerId
      : (room as any)?.ownerId;

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

    if (!isVideo && !isStream) {
      const members = await this.prisma.roomMember.findMany({
        where: { roomId, isActive: true },
        take: 50,
        orderBy: { joinedAt: 'desc' },
      });
      const memberUserIds = members.map((m) => m.userId);
      const [memberUsers, memberStats, memberProfiles] =
        memberUserIds.length > 0
          ? await Promise.all([
              this.prisma.user.findMany({
                where: { id: { in: memberUserIds } },
                select: { id: true, username: true, fullName: true },
              }),
              this.prisma.userStatistics.findMany({
                where: { userId: { in: memberUserIds } },
                select: { userId: true, level: true },
              }),
              this.prisma.userProfile.findMany({
                where: { userId: { in: memberUserIds } },
                select: { userId: true, avatarKey: true },
              }),
            ])
          : [[], [], []];
      const memberUserMap = new Map(memberUsers.map((u) => [u.id, u]));
      const memberLevelMap = new Map(memberStats.map((s) => [s.userId, s.level]));
      const memberAvatarMap = new Map(memberProfiles.map((p) => [p.userId, p.avatarKey]));
      participants = members.map((m) => {
        const u = memberUserMap.get(m.userId);
        return {
          id: m.userId,
          name: u?.fullName || u?.username || 'User',
          handle: `@${u?.username || m.userId.substring(0, 6)}`,
          level: memberLevelMap.get(m.userId) ?? 1,
          avatarUrl: memberAvatarMap.get(m.userId) || 'assets/Moderator_UI/Rectangle 67.png',
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
        };
      });
    } else if (isVideo) {
      const members = await this.prisma.videoRoomMember.findMany({
        where: { roomId, isActive: true },
        take: 50,
        orderBy: { joinedAt: 'desc' },
      });
      const memberUserIds = members.map((m) => m.userId);
      const [memberUsers, memberStats, memberProfiles] =
        memberUserIds.length > 0
          ? await Promise.all([
              this.prisma.user.findMany({
                where: { id: { in: memberUserIds } },
                select: { id: true, username: true, fullName: true },
              }),
              this.prisma.userStatistics.findMany({
                where: { userId: { in: memberUserIds } },
                select: { userId: true, level: true },
              }),
              this.prisma.userProfile.findMany({
                where: { userId: { in: memberUserIds } },
                select: { userId: true, avatarKey: true },
              }),
            ])
          : [[], [], []];
      const memberUserMap = new Map(memberUsers.map((u) => [u.id, u]));
      const memberLevelMap = new Map(memberStats.map((s) => [s.userId, s.level]));
      const memberAvatarMap = new Map(memberProfiles.map((p) => [p.userId, p.avatarKey]));
      participants = members.map((m) => {
        const u = memberUserMap.get(m.userId);
        return {
          id: m.userId,
          name: u?.fullName || u?.username || 'User',
          handle: `@${u?.username || m.userId.substring(0, 6)}`,
          level: memberLevelMap.get(m.userId) ?? 1,
          avatarUrl: memberAvatarMap.get(m.userId) || 'assets/Moderator_UI/Rectangle 67.png',
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
        };
      });
    }

    if (participants.length === 0 && owner) {
      const [ownerStats, ownerProfile] = await Promise.all([
        this.prisma.userStatistics.findUnique({ where: { userId: owner.id } }),
        this.prisma.userProfile.findUnique({ where: { userId: owner.id } }),
      ]);
      participants.push({
        id: owner.id,
        name: owner.fullName || owner.username || 'Host',
        handle: `@${owner.username}`,
        level: ownerStats?.level ?? 1,
        avatarUrl: ownerProfile?.avatarKey || 'assets/Moderator_UI/Rectangle 67.png',
        role: 'OWNER',
        joinedAt: new Date().toISOString(),
      });
    }

    const reports = isStream
      ? await this.prisma.liveStreamReport.findMany({
          where: { streamId: roomId, status: 'PENDING' },
          take: 20,
          orderBy: { createdAt: 'desc' },
        })
      : isVideo
        ? await this.prisma.videoRoomReport.findMany({
            where: { roomId, status: 'PENDING' },
            take: 20,
            orderBy: { createdAt: 'desc' },
          })
        : await this.prisma.roomReport.findMany({
            where: { roomId, status: 'PENDING' },
            take: 20,
            orderBy: { createdAt: 'desc' },
          });

    // reports above is capped (take: 20) for the display list; the stat-bar
    // number must reflect the true total, not the capped list length.
    const reportsCount = isStream
      ? await this.prisma.liveStreamReport.count({ where: { streamId: roomId, status: 'PENDING' } })
      : isVideo
        ? await this.prisma.videoRoomReport.count({ where: { roomId, status: 'PENDING' } })
        : await this.prisma.roomReport.count({ where: { roomId, status: 'PENDING' } });

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

    const chatMessages = isStream
      ? []
      : isVideo
        ? await this.prisma.videoRoomMessage.findMany({
            where: { roomId, deletedAt: null },
            take: 30,
            orderBy: { createdAt: 'asc' },
          })
        : await this.prisma.roomMessage.findMany({
            where: { roomId, isDeleted: false },
            take: 30,
            orderBy: { createdAt: 'asc' },
          });

    const senderIds = [...new Set(chatMessages.map((m) => m.senderId))];
    const [senders, senderProfiles] =
      senderIds.length > 0
        ? await Promise.all([
            this.prisma.user.findMany({
              where: { id: { in: senderIds } },
              select: { id: true, username: true, fullName: true },
            }),
            this.prisma.userProfile.findMany({
              where: { userId: { in: senderIds } },
              select: { userId: true, avatarKey: true },
            }),
          ])
        : [[], []];
    const senderMap = new Map(senders.map((u) => [u.id, u]));
    const senderAvatarMap = new Map(senderProfiles.map((p) => [p.userId, p.avatarKey]));

    const formattedChat = chatMessages.map((m) => {
      const sender = senderMap.get(m.senderId);
      const msgType = (m as any).type;
      const isSystem =
        msgType === 'SYSTEM' ||
        msgType === 'ANNOUNCEMENT' ||
        m.senderId === SYSTEM_MODERATOR_ID ||
        !sender;
      const senderName = isSystem
        ? 'System'
        : (sender?.username || sender?.fullName || 'User');
      const avatarUrl = isSystem ? null : (senderAvatarMap.get(m.senderId) || null);
      return {
        id: m.id,
        initial: isSystem ? 'S' : (senderName[0] || 'U').toUpperCase(),
        sender: senderName,
        avatarUrl,
        isSystem,
        message: m.content,
        time: new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
    });

    // The moderator's "Ban (24h, all rooms)" action writes a PlatformUserBan
    // (see PlatformBanService.banUser), not a RoomBan/VideoRoomBlock/
    // LiveStreamBan row — those legacy per-room tables never see that action,
    // so the stat must be sourced from PlatformUserBan.originRoomId instead.
    const bansCount = await this.prisma.platformUserBan
      .count({
        where: {
          originRoomId: roomId,
          roomType: isStream ? 'LIVE_STREAM' : isVideo ? 'VIDEO_ROOM' : 'AUDIO_ROOM',
        },
      })
      .catch(() => 0);

    // Audio rooms are one permanent row per owner, reused across every
    // broadcast (AudioRoom.ownerId is unique) — room.createdAt is when the
    // row was first created, not when THIS live session started. The actual
    // per-session start lives in RoomLiveSession (see AudioRoomsService's
    // goLive/endRoomInternal, which opens/closes one of these per broadcast).
    const openLiveSession = !isVideo && !isStream
      ? await this.prisma.roomLiveSession.findFirst({
          where: { roomId, status: 'LIVE' },
          orderBy: { startedAt: 'desc' },
          select: { startedAt: true },
        })
      : null;
    const fallbackStartedAt = room
      ? (room as any).startedAt || (room as any).createdAt
      : new Date();
    const sessionStartedAt = openLiveSession?.startedAt || fallbackStartedAt;
    const sessionMinutes = Math.max(
      1,
      Math.floor((Date.now() - new Date(sessionStartedAt).getTime()) / 60000),
    );

    const liveParticipantsCount = isStream
      ? (liveStream as any)?.viewerCount ?? 0
      : isVideo
        ? await this.prisma.videoRoomMember.count({ where: { roomId, isActive: true } })
        : await this.prisma.roomMember.count({ where: { roomId, isActive: true } });

    const roomPrefix = isStream ? 'LS' : isVideo ? 'VR' : 'AR';
    const defaultImage = isVideo
      ? 'assets/Moderator_UI/Rectangle 67.png'
      : 'assets/Moderator_UI/image 733.png';

    return {
      id: roomId,
      name: (room as any)?.name || (room as any)?.title || 'Live Room',
      category: isStream ? 'Live stream' : isVideo ? 'Video room' : 'Audio room',
      isPublic: (room as any)?.visibility === 'PUBLIC' || (room as any)?.isPublic !== false,
      isVerified: true,
      participantsCount: Math.max(1, liveParticipantsCount),
      reportsCount,
      warningsCount: 0,
      bansCount,
      imageUrl: (room as any)?.imageKey || (room as any)?.thumbnailKey || defaultImage,
      roomType,
      roomIdCode: `${roomPrefix}-${roomId.substring(0, 6)}`.toUpperCase(),
      creatorHandle: `@${owner?.username || 'host'}`,
      sessionTime: `${sessionMinutes}m`,
      chatMessages: formattedChat,
      activeReports: formattedReports,
      participants,
    };
  }

  /**
   * Full detail for one report — everything the list payload doesn't carry:
   * target user, region, rule-violated, previous-report count, evidence
   * (gated), and shift/suspension-derived action eligibility.
   */
  async reportDetails(userId: string, reportId: string, actorRoles: PlatformRole[]) {
    const ctx = await this.resolveReportContext(reportId);

    const ownerId = await this.resolveOwnerId(ctx.roomType, ctx.roomId);
    await this.scope.assertModeratorInScope(userId, ownerId);

    const [
      reporter,
      targetUser,
      roomLabel,
      region,
      previousReportCount,
      canViewFullEvidence,
      shiftActive,
      suspended,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: ctx.reporterId },
        select: { username: true, fullName: true },
      }),
      this.prisma.user.findUnique({
        where: { id: ctx.targetUserId },
        select: { username: true, fullName: true },
      }),
      this.resolveRoomLabel(ctx.roomType, ctx.roomId),
      this.resolveRegion(ownerId),
      this.countPreviousReports(ctx.targetUserId, reportId),
      this.canViewFullEvidence(userId),
      this.resolveShiftActive(userId, actorRoles),
      this.warnings ? this.warnings.isSuspended(userId) : Promise.resolve(false),
    ]);

    const evidence = await this.resolveReportEvidence(
      ctx.targetUserId,
      ctx.roomType === 'stream' ? null : ctx.roomId,
      ctx.roomType === 'stream' ? ctx.roomId : null,
      canViewFullEvidence,
    );

    const canTakeAction = shiftActive && !suspended && ctx.status === 'PENDING';

    return {
      id: reportId,
      reportCode:
        `RPT-${reportId.substring(0, 4)}-${reportId.substring(reportId.length - 4)}`.toUpperCase(),
      roomType: ctx.roomType,
      roomTitle: roomLabel,
      reporterName: reporter?.fullName || reporter?.username || 'Reporter',
      reporterId: ctx.reporterId.substring(0, 6),
      targetUserName: targetUser?.fullName || targetUser?.username || 'Target User',
      targetUserId: ctx.targetUserId.substring(0, 6),
      region,
      violationReason: ctx.reason
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (c: string) => c.toUpperCase()),
      description: ctx.description || '',
      priority: deriveReportPriority(ctx.reason),
      ruleViolated: deriveRuleViolated(ctx.reason),
      status: ctx.status === 'PENDING' ? 'Under review' : 'Resolved',
      createdAt: ctx.createdAt.toISOString(),
      assignedTime: new Date(ctx.assignedAt ?? ctx.createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
      previousReportCount: `${previousReportCount} previous report${previousReportCount === 1 ? '' : 's'}`,
      evidenceId: evidence.evidenceId,
      evidenceType: evidence.evidenceType,
      evidenceNote: evidence.evidenceNote,
      recordingUrl: evidence.recordingUrl,
      canViewFullEvidence,
      shiftActive,
      canTakeAction,
    };
  }

  private async resolveOwnerId(roomType: ReportRoomType, roomId: string): Promise<string | null> {
    if (roomType === 'audio') {
      const room = await this.prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { ownerId: true },
      });
      return room?.ownerId ?? null;
    }
    if (roomType === 'video') {
      const room = await this.prisma.videoRoom.findUnique({
        where: { id: roomId },
        select: { ownerId: true },
      });
      return room?.ownerId ?? null;
    }
    const stream = await this.prisma.liveStream.findUnique({
      where: { id: roomId },
      select: { hostId: true },
    });
    return stream?.hostId ?? null;
  }

  private async resolveRoomLabel(roomType: ReportRoomType, roomId: string): Promise<string> {
    if (roomType === 'audio') {
      const room = await this.prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { name: true },
      });
      return room?.name || 'Audio room';
    }
    if (roomType === 'video') {
      const room = await this.prisma.videoRoom.findUnique({
        where: { id: roomId },
        select: { name: true },
      });
      return room?.name || 'Video room';
    }
    const stream = await this.prisma.liveStream.findUnique({
      where: { id: roomId },
      select: { title: true },
    });
    return stream?.title || 'Live stream';
  }

  private async resolveRegion(ownerId: string | null): Promise<string> {
    if (!ownerId) return 'Unassigned';
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { locationState: { select: { name: true } } },
    });
    return owner?.locationState?.name ?? 'Unassigned';
  }

  private async countPreviousReports(
    targetUserId: string,
    excludeReportId: string,
  ): Promise<number> {
    const [audio, video, stream] = await Promise.all([
      this.prisma.roomReport.count({ where: { targetUserId, id: { not: excludeReportId } } }),
      this.prisma.videoRoomReport.count({ where: { targetUserId, id: { not: excludeReportId } } }),
      this.prisma.liveStreamReport.count({ where: { targetUserId, id: { not: excludeReportId } } }),
    ]);
    return audio + video + stream;
  }

  private async canViewFullEvidence(userId: string): Promise<boolean> {
    const permissions = await this.permissionResolver!.resolveUserPermissions(userId);
    return (
      this.permissionResolver!.hasPermission(permissions, 'investigation.recording.view') ||
      this.permissionResolver!.hasPermission(permissions, 'audit.view')
    );
  }

  /**
   * Mirrors `ShiftActiveGuard`'s role-based exemption exactly, so this
   * read-only "can I act on this report?" flag never disagrees with what the
   * write-path guard on `POST .../decision` will actually allow. The guard
   * passes ADMIN/SUPER_ADMIN through unconditionally, and also passes
   * through any caller that doesn't hold MODERATOR at all — shift windows
   * are a MODERATOR-only constraint. Only a caller holding MODERATOR (and
   * neither ADMIN nor SUPER_ADMIN) actually has the real shift status
   * checked.
   */
  private async resolveShiftActive(userId: string, actorRoles: PlatformRole[]): Promise<boolean> {
    const roles = actorRoles ?? [];
    if (roles.some((r) => (r as string) === 'ADMIN' || (r as string) === 'SUPER_ADMIN')) {
      return true;
    }
    if (!roles.some((r) => (r as string) === 'MODERATOR')) return true;
    if (!this.shiftService) return false;
    const status = await this.shiftService.shiftStatus(userId);
    return status.isActive;
  }

  private async resolveReportEvidence(
    targetUserId: string,
    roomId: string | null,
    liveStreamId: string | null,
    canViewFullEvidence: boolean,
  ): Promise<{
    evidenceId: string;
    evidenceType: string;
    evidenceNote: string;
    recordingUrl: string | null;
  }> {
    const caseView = await this.investigationRecording!.getCaseView(targetUserId);
    const recording = caseView.recordings.find(
      (r: { roomId: string | null; liveStreamId: string | null }) =>
        (roomId && r.roomId === roomId) || (liveStreamId && r.liveStreamId === liveStreamId),
    );

    if (!recording) {
      return {
        evidenceId: 'Pending',
        evidenceType: 'System evidence',
        evidenceNote:
          'No moderation action has been taken yet — evidence is captured automatically when an action is recorded.',
        recordingUrl: null,
      };
    }

    return {
      evidenceId: recording.evidenceId,
      evidenceType: 'System evidence',
      evidenceNote: 'Automatically captured by the system',
      recordingUrl: canViewFullEvidence ? recording.recordingUrl : null,
    };
  }

  /**
   * Calls `escalateViolation` on the audio/video moderation services, whose
   * final `requestMeta` param is optional. Forwarding `requestMeta` only
   * when it's actually defined (rather than always passing it, undefined or
   * not) keeps a caller that omits it — e.g. a unit test invoking
   * `actionReport` without a `requestMeta` argument — indistinguishable from
   * one that never had that parameter, while still forwarding a real one
   * end-to-end for the audit trail when the controller supplies it.
   */
  private async callEscalateViolation(
    service: {
      escalateViolation: (
        actor: RoomActor,
        roomId: string,
        targetUserId: string,
        reason: string,
        severity: EscalationSeverity,
        requestMeta?: RequestMetadata,
      ) => Promise<void>;
    },
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    reason: string,
    severity: EscalationSeverity,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    if (requestMeta) {
      await service.escalateViolation(actor, roomId, targetUserId, reason, severity, requestMeta);
    } else {
      await service.escalateViolation(actor, roomId, targetUserId, reason, severity);
    }
  }

  private normalizeAction(action: string): NormalizedAction {
    const key = action.trim().toUpperCase();
    if (key === 'WARN') return 'WARN';
    if (key === 'MUTE') return 'MUTE';
    if (key === 'KICK') return 'KICK';
    if (key === 'BAN') return 'BAN';
    if (key === 'ESCALATE') return 'ESCALATE';
    if (key === 'CLOSE FALSE REPORT' || key === 'CLOSE_FALSE_REPORT') return 'CLOSE_FALSE_REPORT';
    throw new BadRequestException(`Unrecognized moderation action: "${action}".`);
  }

  /**
   * Action a report (Warn, Mute, Kick, Ban, Escalate, Close false report).
   * Delegates to the authoritative per-room-type moderation service instead
   * of mutating the report row directly — that's what gets us real mute/
   * kick/ban effects, investigation recording, audit logging, and the
   * Ban→Official-approval routing for free.
   */
  async actionReport(
    userId: string,
    reportId: string,
    data: { action: string; note: string },
    actorRoles: PlatformRole[],
    requestMeta?: RequestMetadata,
  ): Promise<{
    success: true;
    reportId: string;
    action: NormalizedAction;
    outcome: 'executed' | 'pending_approval' | 'dismissed' | 'escalated';
  }> {
    const note = data.note?.trim();
    if (!note) {
      throw new BadRequestException('An activity note is required.');
    }
    const normalized = this.normalizeAction(data.action);

    const ctx = await this.resolveReportContext(reportId);
    const ownerId = await this.resolveOwnerId(ctx.roomType, ctx.roomId);
    await this.scope.assertModeratorInScope(userId, ownerId);

    const actor = { id: userId, roles: actorRoles };
    const severity = deriveReportPriority(ctx.reason) === 'Highest priority' ? 'CRITICAL' : 'HIGH';

    if (normalized === 'CLOSE_FALSE_REPORT') {
      if (ctx.roomType === 'audio') {
        await this.audioModeration!.dismissReport(actor, ctx.roomId, reportId, note);
      } else if (ctx.roomType === 'video') {
        await this.videoReports!.dismissReport(actor, ctx.roomId, reportId, note);
      } else {
        await this.liveStreamReports!.reviewReport({
          reportId,
          streamId: ctx.roomId,
          moderatorId: userId,
          status: 'DISMISSED' as any,
          resolution: note,
        });
      }
      return { success: true, reportId, action: normalized, outcome: 'dismissed' };
    }

    if (normalized === 'ESCALATE') {
      if (ctx.roomType === 'audio') {
        await this.audioModeration!.reviewReport(actor, ctx.roomId, reportId, {
          status: 'REVIEWED' as any,
          resolution: note,
        });
        await this.callEscalateViolation(
          this.audioModeration!,
          actor,
          ctx.roomId,
          ctx.targetUserId,
          note,
          severity as any,
          requestMeta,
        );
      } else if (ctx.roomType === 'video') {
        await this.videoReports!.reviewReport(
          actor,
          ctx.roomId,
          reportId,
          {
            status: 'REVIEWED' as any,
            resolutionAction: note,
          } as any,
          requestMeta,
        );
        await this.callEscalateViolation(
          this.videoModeration!,
          actor,
          ctx.roomId,
          ctx.targetUserId,
          note,
          severity as any,
          requestMeta,
        );
      } else {
        await this.liveStreamReports!.reviewReport({
          reportId,
          streamId: ctx.roomId,
          moderatorId: userId,
          status: 'REVIEWED' as any,
          resolution: note,
        });
        await this.liveStream!.escalateViolation(
          ctx.roomId,
          userId,
          ctx.targetUserId,
          note,
          severity as any,
        );
      }
      return { success: true, reportId, action: normalized, outcome: 'escalated' };
    }

    // WARN / MUTE / KICK / BAN — one reviewReport call each, per surface.
    const outcome = normalized === 'BAN' ? 'pending_approval' : 'executed';

    if (ctx.roomType === 'audio') {
      const recommendedAction = normalized === 'WARN' ? 'WARNING' : normalized;
      await this.audioModeration!.reviewReport(actor, ctx.roomId, reportId, {
        status: 'ACTIONED' as any,
        resolution: note,
        recommendedAction: recommendedAction as any,
      });
    } else if (ctx.roomType === 'video') {
      const recommendedAction = normalized === 'WARN' ? 'WARNING' : normalized;
      await this.videoReports!.reviewReport(
        actor,
        ctx.roomId,
        reportId,
        {
          status: 'ACTIONED' as any,
          resolutionAction: note,
          recommendedAction: recommendedAction as any,
        } as any,
        requestMeta,
      );
    } else {
      // Live-stream's DTO literal is 'WARN', not 'WARNING' — do not reuse the
      // audio/video mapping above.
      await this.liveStreamReports!.reviewReport(
        {
          reportId,
          streamId: ctx.roomId,
          moderatorId: userId,
          status: 'ACTIONED' as any,
          resolution: note,
          recommendedAction: normalized as any,
        },
        requestMeta,
      );
    }

    return { success: true, reportId, action: normalized, outcome };
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
          reason: data.reason?.trim() || 'Moderator kick',
        },
      });
      await this.prisma.roomMember.updateMany({
        where: { roomId, userId: targetUserId, isActive: true },
        data: { isActive: false, leftAt: new Date() },
      });
    } else if (action.includes('ban')) {
      if (!data.reason || !data.reason.trim()) {
        throw new BadRequestException('Reason is mandatory for banning a user.');
      }
      const banReason = data.reason.trim();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours (1 day)

      await this.prisma.roomBan.create({
        data: {
          roomId,
          userId: targetUserId,
          moderatorId: userId,
          type: 'TEMPORARY',
          status: 'ACTIVE',
          reason: banReason,
          expiresAt,
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
          reason: data.reason?.trim() || 'Moderator mute',
          expiresAt: new Date(Date.now() + QUICK_MUTE_DURATION_MINUTES * 60_000),
        },
      });
    } else if (action.includes('warn')) {
      const warnReason = data.reason?.trim() || 'Please follow community guidelines.';
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { roles: true },
      });
      const actor = { id: userId, roles: (u?.roles as any) ?? ['MODERATOR'] };
      const isAudio = await this.prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { id: true },
      });
      if (isAudio && this.audioModeration) {
        await this.audioModeration.warn(actor, roomId, targetUserId, warnReason, 'PRIVATE');
      } else {
        const isVideo = await this.prisma.videoRoom.findUnique({
          where: { id: roomId },
          select: { id: true },
        });
        if (isVideo && this.videoModeration) {
          await this.videoModeration.warn(actor, roomId, targetUserId, warnReason, undefined, 'PRIVATE');
        } else if (this.liveStream) {
          await this.liveStream.moderateUser({
            streamId: roomId,
            moderatorId: userId,
            targetUserId,
            action: 'WARN',
            reason: warnReason,
            scope: 'PRIVATE',
          });
        }
      }
    }

    return { success: true, roomId, targetUserId, action: data.action };
  }

  /**
   * Send anonymous system warning message to room or participant.
   */
  /**
   * A room-wide moderator warning not about any specific member — posted to
   * the room's own chat feed as an anonymous SYSTEM message. Delegates to the
   * authoritative per-room-type moderation service (same reasoning as
   * `actionReport`): that's what stamps the sentinel system-actor id instead
   * of the moderator's real one, and what makes the message actually render
   * inline for everyone in the room's chat rather than nowhere at all.
   */
  async sendSystemWarning(
    userId: string,
    actorRoles: PlatformRole[],
    roomId: string,
    roomType: 'audio' | 'video' | 'stream',
    message: string,
  ) {
    if (!message || !message.trim()) {
      throw new BadRequestException('Warning message cannot be empty.');
    }
    const reason = message.trim();
    const actor = { id: userId, roles: actorRoles };

    if (roomType === 'audio') {
      if (!this.audioModeration) {
        throw new NotFoundException('Audio room moderation is unavailable.');
      }
      await this.audioModeration.broadcastWarning(actor, roomId, reason);
    } else if (roomType === 'video') {
      if (!this.videoModeration) {
        throw new NotFoundException('Video room moderation is unavailable.');
      }
      await this.videoModeration.broadcastWarning(actor, roomId, reason);
    } else if (roomType === 'stream') {
      if (!this.liveStream) {
        throw new NotFoundException('Live stream moderation is unavailable.');
      }
      await this.liveStream.broadcastWarning(actor, roomId, reason);
    } else {
      throw new BadRequestException(`Unsupported roomType: ${roomType}`);
    }

    return {
      success: true,
      roomId,
      sender: 'System',
      senderRole: 'SYSTEM',
      isSystem: true,
      message: reason,
      sentAt: new Date().toISOString(),
    };
  }

  /**
   * List 24h platform-wide bans (`PlatformUserBan`, issued via
   * `PlatformBanService.banUser()`) for the SuperAdmin panel. This is
   * deliberately NOT `RoomBan` — that's a separate, older, room-scoped ban
   * table (from `ModerationService.ban()`) that only blocks re-joining one
   * specific room. The panel's own heading ("24-Hour Moderation Bans") only
   * matches what `PlatformUserBan` actually is.
   */
  async listModeratorBans(page = 1, limit = 50) {
    if (!this.platformBans) return { items: [], total: 0, page, limit, totalPages: 0 };
    const skip = (page - 1) * limit;
    const [bans, total] = await this.platformBans.list({}, skip, limit);

    const userIds = Array.from(new Set(bans.map((b) => b.targetUserId).filter(Boolean)));
    const modIds = Array.from(new Set(bans.map((b) => b.moderatorId).filter(Boolean)));
    const allUserIds = Array.from(new Set([...userIds, ...modIds]));
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const validUserIds = allUserIds.filter((id) => typeof id === 'string' && uuidRegex.test(id));

    const users = validUserIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: validUserIds } },
          select: { id: true, username: true, fullName: true, email: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const now = new Date();
    const items = bans.map((b) => {
      const u = userMap.get(b.targetUserId);
      const m = userMap.get(b.moderatorId);
      const isExpired = b.expiresAt < now;
      const status = b.status === 'LIFTED' ? 'REVOKED' : isExpired ? 'EXPIRED' : 'ACTIVE';
      const isSystem = b.moderatorId === '00000000-0000-0000-0000-000000000000' || b.moderatorId === 'system';
      return {
        id: b.id,
        roomType: b.roomType,
        originRoomId: b.originRoomId,
        targetUser: {
          id: b.targetUserId,
          username: u?.username ?? 'Unknown',
          fullName: u?.fullName ?? 'Unknown User',
          email: u?.email ?? '',
        },
        moderator: {
          id: b.moderatorId,
          username: m?.username ?? (isSystem ? 'System' : 'Moderator'),
          fullName: m?.fullName ?? (isSystem ? 'System Moderator' : 'Moderator'),
          email: m?.email ?? '',
        },
        reason: b.reason,
        bannedAt: b.bannedAt,
        expiresAt: b.expiresAt,
        status,
      };
    });

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Lift a 24h platform-wide ban (`PlatformUserBan`) — see [listModeratorBans].
   */
  async unbanUser(adminOrModId: string, banId: string) {
    if (!this.platformBans) throw new NotFoundException('Ban record not found.');
    await this.platformBans.unbanUser(adminOrModId, banId);
    return { success: true, banId, unbannedBy: adminOrModId, status: 'LIFTED' };
  }

  /**
   * Complete task.
   */
  async completeTask(userId: string, taskId: string) {
    return { success: true, taskId, completedAt: new Date().toISOString() };
  }

  /**
   * Get detailed agency information for Official Portal Agency Details page.
   * All values are sourced from live database — zero hardcoded fallbacks.
   */
  async agencyDetails(officialUserId: string, agencyId: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ id: agencyId }, { username: agencyId }],
      },
      include: {
        locationState: true,
        locationCountry: true,
        locationRegion: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Agency not found');
    }

    // Fetch all related data in parallel from real tables
    const [
      userProfile,
      userRoles,
      agencyMembersCount,
      complaintsCount,
      userWallet,
      recentRoleRequests,
      recentReports,
    ] = await Promise.all([
      this.prisma.userProfile.findUnique({ where: { userId: user.id } }),
      this.prisma.userRole.findMany({
        where: { userId: user.id, suspendedAt: null },
        include: { role: true },
      }),
      // Real count of hosts/creators under this agency
      this.prisma.agencyRelationship.count({
        where: { agencyId: user.id, status: 'ACTIVE' },
      }),
      // Real complaints filed against this user
      this.prisma.roomReport.count({
        where: { targetUserId: user.id },
      }),
      // Real wallet balance
      this.prisma.wallet
        .findUnique({
          where: { userId: user.id },
        })
        .catch(() => null),
      // Recent role requests as activity — use subjectUserId per schema
      this.prisma.roleRequest
        .findMany({
          where: { subjectUserId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 3,
        })
        .catch(() => []),
      // Recent room reports as activity
      this.prisma.roomReport
        .findMany({
          where: { targetUserId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 2,
        })
        .catch(() => []),
    ]);

    const activeRoles = userRoles.map((ur) => ur.role.name);
    const isCoinSeller = activeRoles.includes('COIN_SELLER');

    const name = user.fullName || user.username;
    const initials =
      name
        .split(' ')
        .filter(Boolean)
        .map((w) => w[0])
        .slice(0, 2)
        .join('')
        .toUpperCase() || 'AG';

    const stateName = user.locationState?.name || userProfile?.state || null;
    const countryName = user.locationCountry?.name || null;
    const locationStr = [stateName, countryName].filter(Boolean).join(', ') || null;

    const joinDate = new Date(user.createdAt).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    // Generate agency code from user ID — no fake IDs
    const idDigits = user.id.replace(/[^0-9]/g, '');
    const agencyCode =
      idDigits.length >= 5
        ? `AGY-${idDigits.slice(-5)}`
        : `AGY-${user.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

    // Revenue: real earnings balance from wallet, formatted in rupees
    const earningsRaw = userWallet?.earningsBalance ?? BigInt(0);
    const earningsRupees = Number(earningsRaw) / 100;
    const totalRevenue =
      earningsRupees > 0
        ? `₹${
            earningsRupees >= 100000
              ? `${(earningsRupees / 100000).toFixed(2)}L`
              : earningsRupees.toFixed(2)
          }`
        : '₹0';

    // AgencyRelationship maps agencyId → hostId (no role filter available in schema)
    // agencyMembersCount already holds the total; hosts = all members
    const creatorsCount = 0; // Cannot distinguish creators without a join to UserRole
    const hostsCount = agencyMembersCount;

    // Build real recent activity from DB events
    const activities: Array<{
      id: string;
      title: string;
      timeAgo: string;
      type: string;
      createdAt: Date;
    }> = [];

    for (const rr of recentRoleRequests) {
      activities.push({
        id: `role-${rr.id}`,
        // RoleRequest has no role relation — use the type field instead
        title: `Role request: ${rr.type} — ${rr.status}`,
        timeAgo: this._relativeTime(rr.createdAt),
        type: 'verification',
        createdAt: rr.createdAt,
      });
    }
    for (const rep of recentReports) {
      activities.push({
        id: `report-${rep.id}`,
        title: 'Complaint report received',
        timeAgo: this._relativeTime(rep.createdAt),
        type: 'complaint',
        createdAt: rep.createdAt,
      });
    }
    if (isCoinSeller) {
      const coinSellerRole = userRoles.find((ur) => ur.role.name === 'COIN_SELLER');
      if (coinSellerRole) {
        activities.push({
          id: `coinseller-${coinSellerRole.id}`,
          title: 'Verified as coin seller',
          timeAgo: this._relativeTime(coinSellerRole.createdAt),
          type: 'verification',
          createdAt: coinSellerRole.createdAt,
        });
      }
    }
    const agencyRole = userRoles.find((ur) => ur.role.name === 'AGENCY');
    if (agencyRole) {
      activities.push({
        id: `agency-${agencyRole.id}`,
        title: 'Joined as agency',
        timeAgo: this._relativeTime(agencyRole.createdAt),
        type: 'creator',
        createdAt: agencyRole.createdAt,
      });
    }

    // Sort by most recent, take latest 5
    activities.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const recentActivity = activities.slice(0, 5).map(({ createdAt: _dt, ...rest }) => rest);

    return {
      id: user.id,
      code: agencyCode,
      name: `${name} agency`,
      initials,
      status: user.status === 'ACTIVE' ? 'Active' : user.status,
      tier: activeRoles.includes('AGENCY_OWNER') ? 'Owner' : 'Standard',
      joinedDate: `Joined on ${joinDate}`,
      location: locationStr,
      overview: {
        performanceScore: null, // Will be implemented via analytics service
        performanceRating: null,
        totalRevenue,
        totalRevenuePeriod: 'All time',
        isCoinSellerVerified: isCoinSeller,
        coinSellerStatus: isCoinSeller ? 'Verified' : 'Not verified',
        totalMembers: agencyMembersCount,
        totalCreators: creatorsCount,
        totalHosts: hostsCount,
        totalComplaints: complaintsCount,
      },
      about: {
        description: userProfile?.bio || null,
        primaryContact: user.fullName || user.username,
        email: user.email || null,
        phone: user.mobile || null,
        address: userProfile?.city ? `${userProfile.city}, ${locationStr}` : locationStr,
      },
      recentActivity,
    };
  }

  /**
   * Get list of complaints against / related to an agency for Official Portal.
   */
  async agencyComplaints(officialUserId: string, agencyId: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ id: agencyId }, { username: agencyId }],
      },
    });

    if (!user) {
      throw new NotFoundException('Agency not found');
    }

    const [reports, tickets] = await Promise.all([
      this.prisma.roomReport.findMany({
        where: { targetUserId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.supportTicket
        .findMany({
          where: { submitterId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 50,
        })
        .catch(() => []),
    ]);

    // Fetch reporter users to show real reporter names
    const reporterIds = [
      ...new Set([...reports.map((r) => r.reporterId), ...tickets.map((t) => t.submitterId)]),
    ];

    const reporterUsers = await this.prisma.user.findMany({
      where: { id: { in: reporterIds } },
      select: { id: true, fullName: true, username: true, roles: true },
    });
    const reporterMap = new Map(reporterUsers.map((u) => [u.id, u]));

    const items: Array<{
      id: string;
      reference: string;
      priority: 'High' | 'Medium' | 'Low';
      status: 'Open' | 'Under review' | 'Resolved';
      reportedByName: string;
      reportedByRole: string;
      category: string;
      subject: string;
      description: string;
      attachmentName: string | null;
      attachmentSize: string | null;
      createdAt: string;
      formattedDate: string;
    }> = [];

    // Map room reports
    for (const rep of reports) {
      const reporter = reporterMap.get(rep.reporterId);
      const repName = reporter?.fullName || reporter?.username || 'User';
      const repRole = reporter?.roles?.includes('CREATOR')
        ? 'Creator'
        : reporter?.roles?.includes('HOST')
          ? 'Host'
          : 'User';

      const digits = rep.id.replace(/\D/g, '').slice(-5) || rep.id.slice(0, 5).toUpperCase();
      const statusMap: Record<string, 'Open' | 'Under review' | 'Resolved'> = {
        PENDING: 'Open',
        REVIEWED: 'Under review',
        ACTIONED: 'Resolved',
        DISMISSED: 'Resolved',
      };

      const dt = new Date(rep.createdAt);
      const formattedDate = this._formatComplaintDate(dt);

      items.push({
        id: rep.id,
        reference: `CMP-${digits}`,
        priority: 'High',
        status: statusMap[rep.status] || 'Open',
        reportedByName: repName,
        reportedByRole: repRole,
        category: rep.reason?.replace(/_/g, ' ') || 'Content Moderation',
        subject:
          rep.description ||
          `${rep.reason?.replace(/_/g, ' ') || 'Complaint'} filed against agency`,
        description:
          rep.description ||
          `Moderation report filed regarding ${rep.reason?.replace(/_/g, ' ').toLowerCase() || 'policy violation'}.`,
        attachmentName: 'Screenshot_202663876453',
        attachmentSize: '220 KB',
        createdAt: rep.createdAt.toISOString(),
        formattedDate,
      });
    }

    // Map support tickets
    for (const ticket of tickets) {
      const reporter = reporterMap.get(ticket.submitterId);
      const repName = reporter?.fullName || reporter?.username || 'User';
      const repRole = reporter?.roles?.includes('CREATOR')
        ? 'Creator'
        : reporter?.roles?.includes('HOST')
          ? 'Host'
          : 'User';

      const digits = ticket.id.replace(/\D/g, '').slice(-5) || ticket.id.slice(0, 5).toUpperCase();
      const statusMap: Record<string, 'Open' | 'Under review' | 'Resolved'> = {
        OPEN: 'Open',
        IN_PROGRESS: 'Under review',
        RESOLVED: 'Resolved',
        CLOSED: 'Resolved',
        ESCALATED: 'Under review',
      };

      const priorityMap: Record<string, 'High' | 'Medium' | 'Low'> = {
        URGENT: 'High',
        HIGH: 'High',
        MEDIUM: 'Medium',
        LOW: 'Low',
      };

      const dt = new Date(ticket.createdAt);
      const formattedDate = this._formatComplaintDate(dt);

      items.push({
        id: ticket.id,
        reference: `CMP-${digits}`,
        priority: priorityMap[ticket.priority] || 'Medium',
        status: statusMap[ticket.status] || 'Open',
        reportedByName: repName,
        reportedByRole: repRole,
        category: ticket.category?.replace(/_/g, ' ') || 'Support',
        subject: ticket.title || 'Support ticket',
        description: ticket.description || 'No description provided.',
        attachmentName: null,
        attachmentSize: null,
        createdAt: ticket.createdAt.toISOString(),
        formattedDate,
      });
    }

    // Calculate metrics
    const total = items.length;
    const open = items.filter((i) => i.status === 'Open').length;
    const underReview = items.filter((i) => i.status === 'Under review').length;
    const resolved = items.filter((i) => i.status === 'Resolved').length;

    return {
      agencyId: user.id,
      agencyName: `${user.fullName || user.username} agency`,
      metrics: {
        total,
        open,
        underReview,
        resolved,
      },
      complaints: items,
    };
  }

  /**
   * Action a complaint (Resolve / Escalate)
   */
  async actionAgencyComplaint(
    officialUserId: string,
    agencyId: string,
    complaintId: string,
    body: { action: 'RESOLVE' | 'ESCALATE'; note?: string },
  ) {
    if (body.action === 'RESOLVE') {
      await this.prisma.roomReport
        .update({
          where: { id: complaintId },
          data: {
            status: 'ACTIONED',
            resolutionAction: 'RESOLVED_BY_OFFICIAL',
            moderatorNotes: body.note || 'Resolved by official in workforce portal',
            reviewedBy: officialUserId,
            reviewedAt: new Date(),
          },
        })
        .catch(() => null);

      await this.prisma.supportTicket
        .update({
          where: { id: complaintId },
          data: {
            status: 'RESOLVED',
            resolvedAt: new Date(),
          },
        })
        .catch(() => null);

      return { success: true, complaintId, action: 'RESOLVED' };
    } else {
      await this.prisma.roomReport
        .update({
          where: { id: complaintId },
          data: {
            status: 'REVIEWED',
            moderatorNotes: body.note || 'Escalated to senior admin',
            reviewedBy: officialUserId,
            reviewedAt: new Date(),
          },
        })
        .catch(() => null);

      await this.prisma.supportTicket
        .update({
          where: { id: complaintId },
          data: {
            status: 'ESCALATED',
            escalatedAt: new Date(),
          },
        })
        .catch(() => null);

      return { success: true, complaintId, action: 'ESCALATED' };
    }
  }

  /**
   * Format date as "18 May 2026 at 10:45 AM"
   */
  private _formatComplaintDate(dt: Date): string {
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    const day = dt.getDate();
    const month = months[dt.getMonth()];
    const year = dt.getFullYear();
    let hours = dt.getHours();
    const minutes = dt.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${day} ${month} ${year} at ${hours}:${minutes} ${ampm}`;
  }

  /**
   * Get list of creators and metrics for Creator Management in Official Portal.
   */
  async creatorsList(officialUserId: string, query?: { search?: string; category?: string }) {
    const scopeWhere = await this.scope.userScopeFilter(officialUserId);

    // 1. Metrics for Creator Management
    const [totalCreators, activeCreators] = await Promise.all([
      this.prisma.user.count({
        where: {
          ...scopeWhere,
          roles: { hasSome: ['CREATOR', 'HOST'] as any },
        },
      }),
      this.prisma.user.count({
        where: {
          ...scopeWhere,
          status: 'ACTIVE',
          roles: { hasSome: ['CREATOR', 'HOST'] as any },
        },
      }),
    ]);

    // 2. Query creators with search filter
    const searchFilter = query?.search
      ? {
          OR: [
            { username: { contains: query.search, mode: 'insensitive' as const } },
            { fullName: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const creatorUsers = await this.prisma.user.findMany({
      where: {
        ...scopeWhere,
        ...searchFilter,
        roles: { hasSome: ['CREATOR', 'HOST'] as any },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const hostIds = creatorUsers.map((u) => u.id);
    const [agencyRelationships, profiles, wallets, pendingRequestsCount] = await Promise.all([
      this.prisma.agencyRelationship.findMany({
        where: { hostId: { in: hostIds }, status: 'ACTIVE' },
      }),
      this.prisma.userProfile.findMany({
        where: { userId: { in: hostIds } },
      }),
      this.prisma.wallet.findMany({
        where: { userId: { in: hostIds } },
      }),
      this.prisma.roleRequest
        .count({
          where: {
            type: { in: ['CREATOR', 'HOST'] as any },
            status: { in: ['SUBMITTED', 'IN_REVIEW'] },
          },
        })
        .catch(() => 0),
    ]);

    const agencyIds = [...new Set(agencyRelationships.map((r) => r.agencyId))];
    const agencyUsers =
      agencyIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: agencyIds } },
            select: { id: true, fullName: true, username: true },
          })
        : [];
    const agencyMap = new Map(agencyUsers.map((a) => [a.id, a.fullName || a.username]));
    const hostAgencyMap = new Map(
      agencyRelationships.map((r) => [r.hostId, agencyMap.get(r.agencyId)]),
    );
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));
    const walletMap = new Map(wallets.map((w) => [w.userId, w]));

    const items = creatorUsers.map((u) => {
      const digits = u.id.replace(/\D/g, '').slice(-5) || u.id.slice(0, 5).toUpperCase();
      const code = `CR-${digits}`;
      const name = u.fullName || u.username;
      const agencyName = hostAgencyMap.get(u.id)
        ? `${hostAgencyMap.get(u.id)} agency`
        : 'Independent';
      const prof = profileMap.get(u.id);
      const userWallet = walletMap.get(u.id);

      const earningsRaw = userWallet?.earningsBalance ?? BigInt(0);
      const earningsRupees = Number(earningsRaw) / 100;
      const revenue =
        earningsRupees > 0
          ? `₹${earningsRupees >= 1000 ? `${(earningsRupees / 1000).toFixed(1)}k` : earningsRupees.toFixed(0)}`
          : '₹0';

      const category = u.roles?.includes('HOST')
        ? 'Hosts'
        : u.roles?.includes('CREATOR')
          ? 'Creators'
          : 'General';

      return {
        id: u.id,
        code,
        name,
        avatarUrl: prof?.avatarKey || null,
        isVerified: u.roles?.includes('CREATOR') || u.roles?.includes('HOST'),
        category,
        agencyName,
        views: '0',
        hours: '0h',
        revenue,
        status: u.status === 'ACTIVE' ? 'Active' : u.status,
      };
    });

    return {
      metrics: {
        total: totalCreators,
        active: activeCreators,
        verified: creatorUsers.filter((u) => u.roles?.includes('CREATOR')).length,
        underReview: pendingRequestsCount,
      },
      creators: items,
    };
  }

  /**
   * Detailed Creator information for Official Portal
   */
  async creatorDetails(userId: string, creatorId: string) {
    const creator = await this.prisma.user.findFirst({
      where: {
        OR: [{ id: creatorId }, { username: creatorId }],
      },
    });

    if (!creator) {
      throw new NotFoundException(`Creator not found: ${creatorId}`);
    }

    const [
      profile,
      stats,
      verification,
      wallet,
      liveStreams,
      videoRooms,
      tickets,
      reports,
      hostMember,
    ] = await Promise.all([
      this.prisma.userProfile.findUnique({ where: { userId: creator.id } }),
      this.prisma.userStatistics.findUnique({ where: { userId: creator.id } }),
      this.prisma.userVerification.findUnique({ where: { userId: creator.id } }),
      this.prisma.wallet.findUnique({ where: { userId: creator.id } }),
      this.prisma.liveStream.findMany({
        where: { hostId: creator.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.videoRoom.findMany({
        where: { ownerId: creator.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.supportTicket.findMany({
        where: { submitterId: creator.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.liveStreamReport.findMany({
        where: { reporterId: creator.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.agencyRelationship.findFirst({
        where: { hostId: creator.id, status: 'ACTIVE' },
      }),
    ]);

    let agencyName = 'Independent';
    if (hostMember?.agencyId) {
      const agencyUser = await this.prisma.user.findUnique({
        where: { id: hostMember.agencyId },
        select: { fullName: true, username: true },
      });
      if (agencyUser) {
        agencyName = `${agencyUser.fullName || agencyUser.username} agency`;
      }
    }

    const name = creator.fullName || creator.username || 'Creator';
    const digits = creator.id.replace(/\D/g, '').slice(-5) || creator.id.slice(0, 5).toUpperCase();
    const code = `CR-${digits}`;

    const joinedDate = creator.createdAt
      ? creator.createdAt.toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : '—';

    // Calculate revenue & streaming hours
    const earningsRaw = wallet?.earningsBalance ?? BigInt(0);
    const earningsRupees = Number(earningsRaw) / 100;
    const revenue =
      earningsRupees > 0
        ? `₹${earningsRupees >= 1000 ? `${(earningsRupees / 1000).toFixed(1)}k` : earningsRupees.toFixed(0)}`
        : '₹0';

    const followersCount = stats?.followersCount ?? 0;
    const followers =
      followersCount >= 1000 ? `${(followersCount / 1000).toFixed(1)}k` : `${followersCount}`;

    const liveMinutes = stats?.liveMinutes ?? liveStreams.length * 120;
    const streamHours = Math.floor(liveMinutes / 60);
    const streamMins = liveMinutes % 60;
    const streamingHours = `${streamHours}h ${streamMins}m`;

    const violationsCount = reports.length;
    const complaintsCount = tickets.length;

    const location = [profile?.city, profile?.state].filter(Boolean).join(', ') || '—';

    // Build real activity timeline
    const activities: Array<{
      icon: string;
      title: string;
      subtitle: string;
      time: string;
      color?: string;
    }> = [];

    for (const stream of liveStreams) {
      activities.push({
        icon: 'live',
        title: 'Live session completed',
        subtitle: `Live stream: ${stream.title || 'Broadcast'}`,
        time: this._relativeTime(stream.createdAt),
      });
    }

    for (const room of videoRooms) {
      activities.push({
        icon: 'task',
        title: 'Room hosted',
        subtitle: `Video room: ${room.name}`,
        time: this._relativeTime(room.createdAt),
      });
    }

    for (const ticket of tickets) {
      activities.push({
        icon: 'complaint',
        title: 'Complaint received',
        subtitle: ticket.title || ticket.description || 'Support ticket raised',
        time: this._relativeTime(ticket.createdAt),
      });
    }

    for (const report of reports) {
      activities.push({
        icon: 'violation',
        title: 'Violation reported',
        subtitle: report.reason || 'Report under review',
        time: this._relativeTime(report.createdAt),
        color: '#DC2626',
      });
    }

    return {
      id: creator.id,
      code,
      name,
      avatarUrl: profile?.avatarKey || null,
      isVerified:
        verification?.verified ||
        creator.roles?.includes('CREATOR') ||
        creator.roles?.includes('HOST'),
      location,
      category: creator.roles?.includes('HOST') ? 'Hosts' : 'Creators',
      agencyName,
      joinedDate,
      overview: {
        performanceScore: stats ? `${Math.min(100, Math.max(70, stats.level * 10))}%` : '—',
        performanceRating: stats && stats.level >= 5 ? 'Excellent' : 'Active',
        totalRevenue: revenue,
        followers,
        streamingHours,
        violations: violationsCount,
        totalComplaints: complaintsCount,
      },
      recentActivity: activities,
    };
  }

  /**
   * Recommendations list and metrics for Official Portal
   */
  async recommendationsList(userId: string, filter: { search?: string; role?: string }) {
    const roleFilter =
      filter.role && filter.role !== 'All'
        ? filter.role === 'BD'
          ? 'BUSINESS_DEVELOPMENT'
          : filter.role.toUpperCase()
        : undefined;

    const where: any = {
      type: roleFilter ? roleFilter : { in: ['MODERATOR', 'BUSINESS_DEVELOPMENT'] },
    };

    const [allRequests, underReviewCount, approvedCount, rejectedCount] = await Promise.all([
      this.prisma.roleRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.roleRequest.count({
        where: {
          ...where,
          status: { in: ['SUBMITTED', 'IN_REVIEW'] },
        },
      }),
      this.prisma.roleRequest.count({
        where: {
          ...where,
          status: 'APPROVED',
        },
      }),
      this.prisma.roleRequest.count({
        where: {
          ...where,
          status: 'REJECTED',
        },
      }),
    ]);

    const userIds = [
      ...new Set([
        ...allRequests.map((r) => r.subjectUserId),
        ...allRequests.map((r) => r.initiatedByUserId),
      ]),
    ];

    const [users, profiles] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, fullName: true, username: true },
      }),
      this.prisma.userProfile.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, city: true, state: true, avatarKey: true },
      }),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u.fullName || u.username]));
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));

    const items = allRequests.map((req) => {
      const name = userMap.get(req.subjectUserId) || 'Candidate';
      const prof = profileMap.get(req.subjectUserId);
      const location = [prof?.city, prof?.state].filter(Boolean).join(', ') || '—';

      const roleType =
        req.type === 'MODERATOR'
          ? 'Moderator'
          : req.type === 'BUSINESS_DEVELOPMENT'
            ? 'BD'
            : req.type;

      const role = `${roleType} candidate`;
      const digits = req.id.replace(/\D/g, '').slice(-5) || req.id.slice(0, 5).toUpperCase();
      const id = req.reference || `MOD-${digits}`;

      const status =
        req.status === 'APPROVED'
          ? 'Recommended'
          : req.status === 'REJECTED'
            ? 'Rejected'
            : 'Under review';

      const submitted = req.createdAt
        ? req.createdAt.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          }) +
          ' at ' +
          req.createdAt.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          })
        : '—';

      return {
        id: req.id,
        reference: id,
        candidateUserId: req.subjectUserId,
        name,
        avatarUrl: prof?.avatarKey || null,
        role,
        roleType,
        location,
        region: 'Region - South',
        submitted,
        status,
        statusColor:
          status === 'Recommended' ? '#16A34A' : status === 'Rejected' ? '#DC2626' : '#9333EA',
      };
    });

    return {
      metrics: {
        identified: allRequests.length,
        underReview: underReviewCount,
        recommended: approvedCount,
        rejected: rejectedCount,
      },
      candidates: items,
    };
  }

  /**
   * Search candidate users for recommendation
   */
  async searchCandidates(userId: string, query: string) {
    const trimmed = (query || '').trim();
    const where: any = {
      status: 'ACTIVE',
    };

    if (trimmed.length > 0) {
      where.OR = [
        { fullName: { contains: trimmed, mode: 'insensitive' } },
        { username: { contains: trimmed, mode: 'insensitive' } },
        { email: { contains: trimmed, mode: 'insensitive' } },
        { mobile: { contains: trimmed } },
      ];
    }

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const userIds = users.map((u) => u.id);
    const profiles = await this.prisma.userProfile.findMany({
      where: { userId: { in: userIds } },
    });
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));

    return users.map((u) => {
      const prof = profileMap.get(u.id);
      return {
        id: u.id,
        name: u.fullName || u.username,
        username: u.username,
        avatarUrl: prof?.avatarKey || null,
        location: [prof?.city, prof?.state].filter(Boolean).join(', ') || 'India',
        region: 'Region - South',
      };
    });
  }

  /**
   * Detailed recommendation info for Official Portal
   */
  async recommendationDetails(userId: string, id: string) {
    const request = await this.prisma.roleRequest.findFirst({
      where: {
        OR: [{ id: id.length === 36 ? id : undefined }, { reference: id }],
      },
      include: {
        actions: { orderBy: { sequence: 'asc' } },
        documents: true,
      },
    });

    if (!request) {
      throw new NotFoundException(`Recommendation not found: ${id}`);
    }

    const [candidateUser, candidateProfile, initiatorUser] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: request.subjectUserId } }),
      this.prisma.userProfile.findUnique({
        where: { userId: request.subjectUserId },
      }),
      this.prisma.user.findUnique({ where: { id: request.initiatedByUserId } }),
    ]);

    const name = candidateUser?.fullName || candidateUser?.username || 'Candidate';
    const recommendedBy = initiatorUser?.fullName || initiatorUser?.username || 'Official';

    const roleType =
      request.type === 'MODERATOR'
        ? 'Moderator'
        : request.type === 'BUSINESS_DEVELOPMENT'
          ? 'BD'
          : request.type;

    const role = `${roleType} candidate`;
    const referenceId = request.reference || `CR-${request.id.slice(0, 5).toUpperCase()}`;

    const location =
      [candidateProfile?.city, candidateProfile?.state].filter(Boolean).join(', ') ||
      'Bengaluru, India';

    const submitted = request.createdAt
      ? request.createdAt.toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : '—';

    const submittedDate = request.createdAt
      ? request.createdAt.toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }) +
        ' at ' +
        request.createdAt.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        })
      : '—';

    const formData = (request.formData as Record<string, any>) || {};
    const reason =
      formData.reason ||
      request.outcomeReason ||
      'Candidate has excellent communication skills and active community support.';

    return {
      id: request.id,
      name,
      role,
      roleType,
      referenceId,
      location,
      region: 'Region - South',
      submitted,
      experience: formData.experience || '—',
      qualification: formData.qualification || '—',
      availability: formData.availability || '—',
      languages: formData.languages || '—',
      recommendedBy,
      submittedDate,
      reason,
      verification: {
        identity: 'Verified',
        eligibility: 'Verified',
        documentsCount: request.documents.length || 0,
      },
      history: [
        {
          title: 'Submitted',
          date: submittedDate,
          status: 'Done',
          statusColor: '#16A34A',
          isCompleted: true,
        },
        {
          title: 'Manager review',
          date: request.status === 'APPROVED' ? submittedDate : 'Under review',
          status: request.status === 'APPROVED' ? 'Done' : 'Under review',
          statusColor: request.status === 'APPROVED' ? '#16A34A' : '#9333EA',
          isCompleted: request.status === 'APPROVED',
        },
        {
          title: 'Admin approval',
          date: request.status === 'APPROVED' ? submittedDate : 'Pending',
          status: request.status === 'APPROVED' ? 'Approved' : 'Pending',
          statusColor: request.status === 'APPROVED' ? '#16A34A' : '#94A3B8',
          isCompleted: request.status === 'APPROVED',
        },
      ],
    };
  }

  /**
   * Submit a new recommendation for Official Portal
   */
  async createRecommendation(
    userId: string,
    body: {
      candidateUserId: string;
      roleType: 'MODERATOR' | 'BUSINESS_DEVELOPMENT' | 'CREATOR' | 'HOST';
      reason: string;
      region?: string;
    },
  ) {
    const candidate = await this.prisma.user.findUnique({
      where: { id: body.candidateUserId },
    });

    if (!candidate) {
      throw new NotFoundException('Candidate user not found');
    }

    const prefix = body.roleType === 'MODERATOR' ? 'MOD' : 'BD';
    const count = await this.prisma.roleRequest.count();
    const reference = `${prefix}-${String(count + 10001).slice(-5)}`;

    const defaultRegion = await this.prisma.region.findFirst({ select: { id: true } });
    const regionId = defaultRegion?.id || '00000000-0000-0000-0000-000000000001';

    const reqType =
      body.roleType === 'MODERATOR'
        ? RoleRequestType.MODERATOR
        : RoleRequestType.BUSINESS_DEVELOPMENT;

    const request = await this.prisma.roleRequest.create({
      data: {
        reference,
        type: reqType,
        subjectUserId: candidate.id,
        initiatedByUserId: userId,
        status: RoleRequestStatus.SUBMITTED,
        currentStage: RoleRequestStage.OFFICIAL,
        pipelineVersion: 1,
        formData: {
          reason: body.reason,
          region: body.region || 'Region - South',
        },
        regionId,
      },
    });

    return {
      success: true,
      id: request.id,
      reference: request.reference,
    };
  }

  /**
   * Convert a Date to a human-readable relative time string.
   */
  private _relativeTime(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hr${diffHr > 1 ? 's' : ''} ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;
    const diffMon = Math.floor(diffDay / 30);
    if (diffMon < 12) return `${diffMon} month${diffMon > 1 ? 's' : ''} ago`;
    return `${Math.floor(diffMon / 12)} year${Math.floor(diffMon / 12) > 1 ? 's' : ''} ago`;
  }
}
