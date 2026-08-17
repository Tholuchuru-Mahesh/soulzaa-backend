import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { LiveStreamReport, LiveStreamReportReason, LiveStreamReportStatus } from '@prisma/client';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { AuditLogService } from 'src/modules/authorization/services/audit-log.service';
import { ModeratorPerformanceService } from 'src/modules/moderator-performance/services/moderator-performance.service';
import { ModeratorNotificationService } from 'src/modules/moderator-shift/services/moderator-notification.service';
import { ModerationApprovalService } from 'src/modules/moderation-approval/services/moderation-approval.service';
import {
  buildReportReviewReason,
  recordReportResolutionIfConfigured,
} from 'src/modules/moderation-approval/utils/report-review-outcome.util';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { LiveStreamReportRepository } from '../repositories/live-stream-report.repository';
import { LiveStreamService } from './live-stream.service';

/** Report reasons that page a moderator immediately rather than waiting in the normal report queue. */
const HIGH_PRIORITY_REPORT_REASONS: LiveStreamReportReason[] = [
  LiveStreamReportReason.THREATS,
  LiveStreamReportReason.SEXUAL_CONTENT,
];

export interface FileLiveStreamReportInput {
  streamId: string;
  reporterId: string;
  targetUserId: string;
  reason: LiveStreamReportReason;
  description?: string;
}

export interface ReviewLiveStreamReportInput {
  streamId: string;
  reportId: string;
  moderatorId: string;
  status: LiveStreamReportStatus;
  resolution?: string;
  recommendedAction?: 'WARN' | 'MUTE' | 'KICK' | 'BAN';
}

/**
 * Report management for Live Stream viewers — mirrors Audio Room's
 * `ModerationService` report methods and Video Room's `VideoRoomReportService`.
 * A recommended action executes immediately via `LiveStreamService.moderateUser`
 * (the moderator already has direct mute/kick/ban authority; "recommend" is an
 * audit-trail label distinguishing an async report-review decision from live
 * observation, not a separate approval gate — same design as Audio Room).
 */
@Injectable()
export class LiveStreamReportService {
  constructor(
    private readonly reportRepo: LiveStreamReportRepository,
    private readonly liveStream: LiveStreamService,
    private readonly scopeService: WorkforceScopeService,
    @Optional() private readonly performanceStats?: ModeratorPerformanceService,
    @Optional() private readonly auditLog?: AuditLogService,
    @Optional() private readonly moderatorNotify?: ModeratorNotificationService,
    @Optional() private readonly approvalService?: ModerationApprovalService,
  ) {}

  async fileReport(input: FileLiveStreamReportInput): Promise<LiveStreamReport> {
    if (input.reporterId === input.targetUserId) {
      throw new BadRequestException('You cannot report yourself.');
    }
    const stream = await this.liveStream.getStream(input.streamId);

    const existing = await this.reportRepo.findOpenReport(
      input.streamId,
      input.reporterId,
      input.targetUserId,
    );
    if (existing) {
      throw new ConflictException('You already have an open report against this user.');
    }

    const report = await this.reportRepo.createReport({
      streamId: input.streamId,
      reporterId: input.reporterId,
      targetUserId: input.targetUserId,
      reason: input.reason,
      description: input.description ?? null,
    });

    if (this.moderatorNotify && HIGH_PRIORITY_REPORT_REASONS.includes(input.reason)) {
      const moderatorIds = await this.scopeService.resolveModeratorsInScope(stream.regionId);
      await Promise.all(
        moderatorIds.map((moderatorId) =>
          this.moderatorNotify!.notifyHighPriorityReport(moderatorId, report.id, input.reason),
        ),
      );
    }

    return report;
  }

  async reviewReport(input: ReviewLiveStreamReportInput, requestMeta?: RequestMetadata): Promise<void> {
    const report = await this.reportRepo.getReport(input.reportId);
    if (!report || report.streamId !== input.streamId) {
      throw new NotFoundException('Report not found.');
    }
    if (report.status !== LiveStreamReportStatus.PENDING) {
      throw new ConflictException('That report has already been reviewed.');
    }

    const stream = await this.liveStream.getStream(input.streamId);
    await this.scopeService.assertModeratorInScope(input.moderatorId, stream?.regionId ?? null);

    await this.reportRepo.reviewReport(
      input.reportId,
      input.moderatorId,
      input.status,
      input.resolution ?? null,
    );

    if (input.recommendedAction) {
      // Tagged distinctly from a live in-room action — see class doc.
      const reason = buildReportReviewReason(input.reportId, input.resolution, input.recommendedAction);
      if (input.recommendedAction === 'BAN') {
        // Hard to reverse, so it does not auto-execute like WARN/MUTE/KICK —
        // it goes to the Official covering the stream's region as a pending
        // approval instead (see ModerationApprovalService). If the approval
        // service isn't wired, the recommendation is left unactioned rather
        // than silently executing without the review it needs.
        if (this.approvalService) {
          await this.approvalService.propose({
            roomType: 'LIVE_STREAM',
            liveStreamId: input.streamId,
            reportId: input.reportId,
            proposedBy: input.moderatorId,
            targetUserId: report.targetUserId,
            reason,
            regionId: stream?.regionId ?? null,
          });
        }
      } else {
        await this.liveStream.moderateUser({
          streamId: input.streamId,
          moderatorId: input.moderatorId,
          targetUserId: report.targetUserId,
          action: input.recommendedAction,
          reason,
        });
      }
    }

    await recordReportResolutionIfConfigured(
      this.performanceStats,
      input.moderatorId,
      report.createdAt,
    );

    if (this.auditLog) {
      void this.auditLog.logAction({
        actorId: input.moderatorId,
        action: 'live_stream.report_reviewed',
        resource: 'live_stream',
        resourceId: input.streamId,
        targetUserId: report.targetUserId,
        violationReason: input.resolution ?? report.reason,
        ipAddress: requestMeta?.ip,
        userAgent: requestMeta?.userAgent,
        details: {
          reportId: input.reportId,
          status: input.status,
          recommendedAction: input.recommendedAction ?? null,
        },
      });
    }
  }

  async addNotes(streamId: string, reportId: string, moderatorId: string, notes: string): Promise<void> {
    const report = await this.reportRepo.getReport(reportId);
    if (!report || report.streamId !== streamId) {
      throw new NotFoundException('Report not found.');
    }
    const stream = await this.liveStream.getStream(streamId);
    await this.scopeService.assertModeratorInScope(moderatorId, stream?.regionId ?? null);
    await this.reportRepo.addNotes(reportId, notes);
  }

  async listReports(streamId: string, page = 1, limit = 20, targetUserId?: string) {
    const skip = (page - 1) * limit;
    const [items, total] = await this.reportRepo.listReports(streamId, skip, limit, targetUserId);
    return { items, total, page, limit };
  }
}
