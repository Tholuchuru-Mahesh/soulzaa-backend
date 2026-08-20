import { InjectQueue } from '@nestjs/bullmq';
import { forwardRef, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  Prisma,
  VideoRoomModerationActionType,
  VideoRoomModerationMuteType,
  VideoRoomReport,
  VideoRoomReportReason,
  VideoRoomReportStatus,
} from '@prisma/client';
import type { Queue } from 'bullmq';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  SYSTEM_MODERATOR_ID,
  VIDEO_ROOM_MODERATION_QUEUES,
} from '../constants/video-room-moderation.constants';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type {
  ListModerationDto,
  ReportVideoRoomUserDto,
  ReviewReportDto,
} from '../dto/moderation.dto';
import { ReportException } from '../exceptions/video-room-moderation.exceptions';
import { ReportReviewedEvent, UserReportedEvent } from '../events/video-room-moderation.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomModerationMetrics } from '../metrics/video-room-moderation.metrics';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomReportRepository } from '../repositories/video-room-report.repository';
import { VideoRoomRolesRepository } from '../repositories/video-room-roles.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import {
  VideoRoomPermissionService,
  type PermissionRoomRef,
} from './video-room-permission.service';

import { ModeratorPerformanceService } from 'src/modules/moderator-performance/services/moderator-performance.service';
import { ModeratorNotificationService } from 'src/modules/moderator-shift/services/moderator-notification.service';
import { ModerationApprovalService } from 'src/modules/moderation-approval/services/moderation-approval.service';
import {
  buildReportReviewReason,
  recordReportResolutionIfConfigured,
} from 'src/modules/moderation-approval/utils/report-review-outcome.util';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { VideoRoomModerationService } from './video-room-moderation.service';

import { InvestigationRecordingService } from 'src/modules/investigation-recording/services/investigation-recording.service';

/** Report reasons that page a moderator immediately rather than waiting in the normal report queue. */
const HIGH_PRIORITY_REPORT_REASONS: VideoRoomReportReason[] = [
  VideoRoomReportReason.THREATS,
  VideoRoomReportReason.SEXUAL_CONTENT,
];

/**
 * Phase 16 reporting: a member (any active role, including audience/viewer —
 * gated by `@NotGuest` at the controller, not here) files a report against
 * another user, optionally about a specific chat message; a moderator later
 * triages it. Mirrors the Audio Room `ModerationService`'s report/reviewReport
 * pair (`moderatorRecipients` fan-out, `appendAction(REPORT_REVIEWED)`), but
 * scoped to its own repository/events/metrics and this module's `REVIEW_REPORTS`
 * gate for triage (there is no separate "notes"/appeal surface here).
 *
 * `VideoRoomsRepository` alone has no elevated-member lookup — that lives on
 * `VideoRoomRolesRepository.listActiveByRoom` (the durable elevated-grant
 * table VR-7 introduced) — so recipients are built from that repo's grants
 * plus the room's `ownerId`, minus the reporter.
 */
@Injectable()
export class VideoRoomReportService {
  constructor(
    private readonly reportRepo: VideoRoomReportRepository,
    private readonly rooms: VideoRoomsRepository,
    private readonly roles: VideoRoomRolesRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly moderationRepo: VideoRoomModerationRepository,
    private readonly metrics: VideoRoomModerationMetrics,
    @InjectQueue(VIDEO_ROOM_MODERATION_QUEUES.REPORT) private readonly queue: Queue,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(forwardRef(() => VideoRoomModerationService))
    private readonly moderation: VideoRoomModerationService,
    private readonly scopeService: WorkforceScopeService,
    @Optional() private readonly performanceStats?: ModeratorPerformanceService,
    @Optional() private readonly moderatorNotify?: ModeratorNotificationService,
    @Optional() private readonly approvalService?: ModerationApprovalService,
    @Optional() private readonly investigationRecording?: InvestigationRecordingService,
  ) {}

  /**
   * File a report. Refuses self-reports, an unknown room, and a duplicate
   * open (PENDING) report already filed by this reporter against this target
   * (scoped to the same message when `messageId` is given). Notifies every
   * elevated member + the owner (never the reporter) via both the domain
   * event (bridged to sockets, recipients-only — never a room broadcast) and
   * the shared `notifications` queue.
   *
   * Task 9: gated by `settings.allowReporting`, checked after the active-
   * member assertion (so membership errors still take precedence) and
   * before the duplicate-report lookup — no owner/admin bypass, whoever can
   * flip the flag can turn it back on. This is the ONLY guarded entry point
   * in this service: `reviewReport`/`listReports` stay unguarded so
   * moderators can still triage a pre-existing queue, and
   * `createSystemReport` — the auto-moderation engine's own path — stays
   * unguarded so a room owner can never use this user-facing toggle to
   * blind automated safety detection in their own room.
   */
  async report(
    reporter: RoomActor,
    roomId: string,
    dto: ReportVideoRoomUserDto,
  ): Promise<VideoRoomReport> {
    if (dto.targetUserId === reporter.id) {
      throw new ReportException(
        ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF,
        'You cannot report yourself.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const ref = await this.requireRoom(roomId);
    await this.assertActiveMember(ref.id, reporter.id);

    const settings = await this.rooms.requireSettings(ref.id);
    if (!settings.allowReporting) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Reporting is disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    const existing = await this.reportRepo.findOpen(
      ref.id,
      reporter.id,
      dto.targetUserId,
      dto.messageId,
    );
    if (existing) {
      throw new ReportException(
        ERROR_CODES.VIDEO_ROOM_DUPLICATE_REPORT,
        'You already have a pending report against this user.',
        HttpStatus.CONFLICT,
      );
    }

    const report = await this.reportRepo.create({
      roomId: ref.id,
      reporterId: reporter.id,
      targetUserId: dto.targetUserId,
      messageId: dto.messageId,
      reason: dto.reason,
      description: dto.description,
    });

    if (this.investigationRecording) {
      void this.investigationRecording.captureReportEvidence({
        reportId: report.id,
        roomId: ref.id,
        roomType: 'video',
        targetUserId: dto.targetUserId,
        reporterId: reporter.id,
        violationReason: dto.reason,
        description: dto.description,
        ownerId: ref.ownerId,
      });
    }

    await this.notifyRecipients(ref, report, reporter.id);
    return report;
  }

  /**
   * Moderator triage of a pending report: `REVIEW_REPORTS` gate, 404 if
   * the report doesn't exist (or belongs to a different room), conflict if
   * it's already been actioned. Records the resolution, appends the
   * immutable audit row, and publishes `ReportReviewedEvent`.
   */
  async reviewReport(
    actor: RoomActor,
    roomId: string,
    reportId: string,
    dto: ReviewReportDto,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    const ref = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, ref, VideoRoomPermission.REVIEW_REPORTS);

    const room = await this.rooms.findById(roomId);
    if (room?.ownerId) {
      await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    }

    const report = await this.reportRepo.getById(reportId);
    if (!report || report.roomId !== ref.id) {
      throw new ReportException(
        ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND,
        'Report not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (report.status !== 'PENDING') {
      throw new ReportException(
        ERROR_CODES.VIDEO_ROOM_REPORT_NOT_PENDING,
        'That report has already been reviewed.',
        HttpStatus.CONFLICT,
      );
    }

    await this.reportRepo.review(reportId, actor.id, dto.status, dto.resolutionAction);
    await this.moderationRepo.appendAction({
      roomId: ref.id,
      moderatorId: actor.id,
      targetUserId: report.targetUserId,
      action: VideoRoomModerationActionType.REPORT_REVIEWED,
      reason: dto.resolutionAction ?? null,
      metadata: this.auditMetadata(
        { reportId, status: dto.status, recommendedAction: dto.recommendedAction ?? null },
        requestMeta,
      ),
    });

    if (dto.recommendedAction) {
      // Tagged distinctly from a live in-room action: this action was decided
      // during asynchronous report review, not while the moderator was
      // observing the room in real time — same convention as Audio Room's
      // `ModerationService.reviewReport`. The moderator already has direct
      // kick/mute/ban authority, so this executes immediately; the tag is
      // audit-trail clarity, not a separate approval gate.
      const reason = buildReportReviewReason(reportId, dto.resolutionAction, dto.recommendedAction);
      if (dto.recommendedAction === 'WARNING') {
        await this.moderation.warn(
          actor,
          roomId,
          report.targetUserId,
          reason,
          undefined,
          'PRIVATE',
          requestMeta,
        );
      } else if (dto.recommendedAction === 'MUTE') {
        await this.moderation.mute(
          actor,
          roomId,
          { userId: report.targetUserId, type: VideoRoomModerationMuteType.PERMANENT, reason },
          requestMeta,
        );
      } else if (dto.recommendedAction === 'KICK') {
        await this.moderation.kick(actor, roomId, report.targetUserId, reason, requestMeta);
      } else if (dto.recommendedAction === 'BAN') {
        // Hard to reverse, so it does not auto-execute like the other three
        // — it goes to the Official covering the room's region as a pending
        // approval instead (see ModerationApprovalService). If the approval
        // service isn't wired, the recommendation is left unactioned rather
        // than silently executing without the review it needs.
        if (this.approvalService) {
          await this.approvalService.propose({
            roomType: 'VIDEO_ROOM',
            roomId,
            reportId,
            proposedBy: actor.id,
            targetUserId: report.targetUserId,
            reason,
            ownerId: room?.ownerId ?? null,
          });
        }
      }
    }

    await recordReportResolutionIfConfigured(this.performanceStats, actor.id, report.createdAt);

    await this.bus.publish(
      new ReportReviewedEvent({
        roomId: ref.id,
        reportId,
        moderatorId: actor.id,
        targetUserId: report.targetUserId,
        status: dto.status,
        resolutionAction: dto.resolutionAction ?? null,
      }),
    );
  }

  async addReportNotes(
    actor: RoomActor,
    roomId: string,
    reportId: string,
    notes: string,
  ): Promise<void> {
    const ref = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, ref, VideoRoomPermission.REVIEW_REPORTS);
    const room = await this.rooms.findById(roomId);
    if (room?.ownerId) {
      await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    }
    // The scope check above authorizes `roomId`, so the report being mutated
    // must actually belong to that room — otherwise a moderator scoped to
    // this room could pass any out-of-scope room's reportId and edit it.
    const report = await this.reportRepo.getById(reportId);
    if (!report || report.roomId !== ref.id) {
      throw new ReportException(
        ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND,
        'Report not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.reportRepo.updateNotes(reportId, actor.id, notes);
    await this.moderationRepo.appendAction({
      roomId: ref.id,
      moderatorId: actor.id,
      targetUserId: null,
      action: VideoRoomModerationActionType.REPORT_REVIEWED,
      reason: 'Report investigation notes updated',
      metadata: { reportId, notes },
    });
  }

  async dismissReport(
    actor: RoomActor,
    roomId: string,
    reportId: string,
    reason?: string,
  ): Promise<void> {
    const ref = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, ref, VideoRoomPermission.REVIEW_REPORTS);
    const room = await this.rooms.findById(roomId);
    if (room?.ownerId) {
      await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    }
    const report = await this.reportRepo.getById(reportId);
    if (!report || report.roomId !== ref.id) {
      throw new ReportException(
        ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND,
        'Report not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.reportRepo.review(
      reportId,
      actor.id,
      VideoRoomReportStatus.DISMISSED,
      reason ?? 'Dismissed as false report',
    );
    await this.moderationRepo.appendAction({
      roomId: ref.id,
      moderatorId: actor.id,
      targetUserId: null,
      action: VideoRoomModerationActionType.REPORT_REVIEWED,
      reason: reason ?? 'Dismissed as false report',
      metadata: { reportId, status: 'DISMISSED' },
    });
    if (this.performanceStats) {
      const resolutionMinutes = (Date.now() - report.createdAt.getTime()) / 60_000;
      await this.performanceStats.recordReportResolution(actor.id, resolutionMinutes);
    }
  }

  /** Assigns a PENDING report to a moderator, opening it as their investigation. */
  async assignReport(
    actor: RoomActor,
    roomId: string,
    reportId: string,
    assigneeId: string,
  ): Promise<void> {
    const ref = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, ref, VideoRoomPermission.REVIEW_REPORTS);

    const room = await this.rooms.findById(roomId);
    if (room?.ownerId) {
      await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    }

    const report = await this.reportRepo.getById(reportId);
    if (!report || report.roomId !== ref.id) {
      throw new ReportException(
        ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND,
        'Report not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (report.status !== 'PENDING') {
      throw new ReportException(
        ERROR_CODES.VIDEO_ROOM_REPORT_NOT_PENDING,
        'That report has already been reviewed.',
        HttpStatus.CONFLICT,
      );
    }

    await this.reportRepo.assign(reportId, assigneeId);
    if (this.moderatorNotify) {
      await this.moderatorNotify.notifyReportAssigned(assigneeId, reportId, actor.id);
    }
  }

  /** Paginated report listing for moderators (`REVIEW_REPORTS`), optionally filtered by target. */
  async listReports(
    actor: RoomActor,
    roomId: string,
    query: ListModerationDto,
  ): Promise<Paginated<VideoRoomReport>> {
    const ref = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, ref, VideoRoomPermission.REVIEW_REPORTS);

    const [rows, total] = await this.reportRepo.list(ref.id, {
      skip: query.skip,
      take: query.limit,
      targetUserId: query.targetUserId,
    });
    return buildPaginated(rows, total, query.page, query.limit);
  }

  /**
   * System-initiated report (the auto-moderation `auto_flag` outcome): no
   * actor authorization, `reporterId` is the `SYSTEM_MODERATOR_ID` sentinel.
   * Still fans out to moderators exactly like a member-filed report — an
   * auto-flag takes no punitive action on its own, so surfacing it to human
   * review is the whole point.
   */
  async createSystemReport(
    roomId: string,
    targetUserId: string,
    reason: VideoRoomReportReason,
    meta?: Record<string, unknown>,
  ): Promise<VideoRoomReport> {
    const ref = await this.requireRoom(roomId);

    const report = await this.reportRepo.create({
      roomId: ref.id,
      reporterId: SYSTEM_MODERATOR_ID,
      targetUserId,
      reason,
      description: meta ? JSON.stringify(meta) : undefined,
    });

    await this.notifyRecipients(ref, report, SYSTEM_MODERATOR_ID);
    return report;
  }

  // ======================= Internals =======================

  /**
   * Enqueues onto the dedicated Phase-16 `REPORT` queue
   * (`VIDEO_ROOM_MODERATION_QUEUES.REPORT`), not the shared `notifications`
   * queue directly — `ReportProcessingProcessor` (Task 21) forwards the
   * `notify` job onto `notifications` keyed by `type`, so delivery is
   * unchanged while report fan-out owns its own worker/retry/dead-letter
   * lane (VR-16 carry-forward #1).
   */
  private async notifyRecipients(
    ref: PermissionRoomRef,
    report: VideoRoomReport,
    excludeUserId: string,
  ): Promise<string[]> {
    const recipientIds = await this.elevatedRecipients(ref, excludeUserId);

    await this.bus.publish(
      new UserReportedEvent({
        roomId: ref.id,
        reportId: report.id,
        reporterId: report.reporterId,
        targetUserId: report.targetUserId,
        reason: report.reason,
        recipientIds,
      }),
    );
    await this.queue.add('notify', {
      type: 'video_room.reported',
      roomId: ref.id,
      reportId: report.id,
      recipientIds,
    });
    this.metrics.incReport(report.reason);

    if (this.moderatorNotify && HIGH_PRIORITY_REPORT_REASONS.includes(report.reason)) {
      await Promise.all(
        recipientIds.map((moderatorId) =>
          this.moderatorNotify!.notifyHighPriorityReport(moderatorId, report.id, report.reason),
        ),
      );
    }
    return recipientIds;
  }

  /** Elevated grant holders + the room owner, minus `excludeUserId` (the reporter). */
  private async elevatedRecipients(
    ref: PermissionRoomRef,
    excludeUserId: string,
  ): Promise<string[]> {
    const grants = await this.roles.listActiveByRoom(ref.id);
    const ids = new Set(grants.map((grant) => grant.userId));
    ids.add(ref.ownerId);
    ids.delete(excludeUserId);
    return [...ids];
  }

  /**
   * Reporting requires the reporter be present in the room right now — an
   * active `VideoRoomMember` row, which covers both participants and
   * audience/viewers alike (VR-6 folds viewer presence into the same member
   * table, so a `VIEWER`-role row still satisfies this). Refuses a reporter
   * who was never in the room, or whose membership has since ended
   * (`isActive: false` — left/kicked/reconnected-elsewhere).
   */
  private async assertActiveMember(roomId: string, userId: string): Promise<void> {
    const member = await this.rooms.getMember(roomId, userId);
    if (!member?.isActive) {
      throw new ReportException(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'You must be an active member of this room to report a user.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async requireRoom(roomId: string): Promise<PermissionRoomRef> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return { id: room.id, ownerId: room.ownerId };
  }

  /**
   * Merges the `{requestId, ip, userAgent}` carried by the controller's
   * `@RequestMeta()` into an action's own `metadata` blob — mirrors
   * `VideoRoomModerationService.auditMetadata`. `report()` itself has no
   * metadata sink (`VideoRoomReport` carries no JSON column), so only
   * `reviewReport`, which appends into `VideoRoomModerationAction`, calls
   * this.
   */
  private auditMetadata(
    base: Record<string, unknown> | undefined,
    requestMeta?: RequestMetadata,
  ): Prisma.InputJsonValue | undefined {
    if (!base && !requestMeta) return undefined;
    return {
      ...(base ?? {}),
      ...(requestMeta
        ? {
            requestId: requestMeta.requestId ?? null,
            ip: requestMeta.ip ?? null,
            userAgent: requestMeta.userAgent ?? null,
          }
        : {}),
    } as Prisma.InputJsonValue;
  }
}
