import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LiveStreamStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { InvestigationRecordingService } from 'src/modules/investigation-recording/services/investigation-recording.service';
import { ModeratorPerformanceService } from 'src/modules/moderator-performance/services/moderator-performance.service';
import { AuditLogService } from 'src/modules/authorization/services/audit-log.service';
import { PresenceService } from 'src/infra/redis/presence.service';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';

export interface CreateLiveStreamInput {
  hostId: string;
  title?: string;
  description?: string;
}

export interface LiveStreamModerationInput {
  streamId: string;
  moderatorId: string;
  targetUserId: string;
  action: 'WARN' | 'MUTE' | 'KICK' | 'BAN';
  reason?: string;
}

@Injectable()
export class LiveStreamService {
  private readonly logger = new Logger(LiveStreamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly investigationRecording: InvestigationRecordingService,
    private readonly performanceStats: ModeratorPerformanceService,
    private readonly presence: PresenceService,
    private readonly auditLog?: AuditLogService,
    private readonly scopeService?: WorkforceScopeService,
  ) {}

  async createStream(input: CreateLiveStreamInput) {
    // Get host location details if available to populate scope fields
    const host = await this.prisma.user.findUnique({
      where: { id: input.hostId },
      select: { regionId: true, stateId: true, countryId: true },
    });

    return this.prisma.liveStream.create({
      data: {
        id: randomUUID(),
        hostId: input.hostId,
        streamerId: input.hostId,
        title: input.title ?? 'Live Stream',
        description: input.description,
        regionId: host?.regionId ?? null,
        stateId: host?.stateId ?? null,
        countryId: host?.countryId ?? null,
        status: LiveStreamStatus.ACTIVE,
        updatedAt: new Date(),
      },
    });
  }

  async getStream(id: string) {
    const stream = await this.prisma.liveStream.findUnique({
      where: { id },
    });
    if (!stream) throw new NotFoundException('Live stream not found');
    return stream;
  }

  async endStream(id: string, actorId: string) {
    const stream = await this.getStream(id);
    if (stream.status !== LiveStreamStatus.ACTIVE) {
      throw new BadRequestException('Stream is already ended or suspended');
    }

    return this.prisma.liveStream.update({
      where: { id },
      data: {
        status: LiveStreamStatus.ENDED,
        endedAt: new Date(),
        endedBy: actorId,
      },
    });
  }

  async listStreams(filters: { status?: LiveStreamStatus; regionId?: string }, page = 1, limit = 20) {
    const where: Record<string, unknown> = {};
    if (filters.status) where['status'] = filters.status;
    if (filters.regionId) where['regionId'] = filters.regionId;

    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.liveStream.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.liveStream.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  /**
   * Perform moderation action on a user within a live stream.
   * Automatically triggers InvestigationRecording creation and updates KPI stats.
   */
  async moderateUser(input: LiveStreamModerationInput) {
    const stream = await this.getStream(input.streamId);
    if (stream.status !== LiveStreamStatus.ACTIVE) {
      throw new BadRequestException('Cannot moderate a closed stream');
    }

    if (this.scopeService) {
      await this.scopeService.assertModeratorInScope(input.moderatorId, stream.regionId);
    }

    // 1. Begin investigation recording for evidence snapshot
    const recording = await this.investigationRecording.beginRecording({
      moderatorId: input.moderatorId,
      targetUserId: input.targetUserId,
      liveStreamId: input.streamId,
      regionId: stream.regionId ?? undefined,
      violationReason: input.reason ?? `Live stream moderation: ${input.action}`,
      evidencePayload: {
        streamId: input.streamId,
        hostId: stream.hostId,
        action: input.action,
        timestamp: new Date().toISOString(),
      },
    });

    // 2. Execute action row creation
    const actionRow = await this.prisma.live_stream_moderation_actions.create({
      data: {
        id: randomUUID(),
        streamId: input.streamId,
        moderatorId: input.moderatorId,
        targetUserId: input.targetUserId,
        action: input.action,
        reason: input.reason ?? null,
        evidenceId: recording.evidenceId,
      },
    });

    // 3. Complete investigation recording
    await this.investigationRecording.completeRecording({
      recordingId: recording.id,
      actionTaken: input.action,
      evidencePayload: { actionId: actionRow.id },
    });

    // 4. Update Moderator KPI stats
    await this.performanceStats.recordAction(
      input.moderatorId,
      input.action as any,
    );

    if (this.auditLog) {
      void this.auditLog.logAction({
        actorId: input.moderatorId,
        action: `live_stream.${input.action.toLowerCase()}`,
        resource: 'live_stream',
        resourceId: input.streamId,
        details: { targetUserId: input.targetUserId, reason: input.reason ?? null },
      });
    }

    // If action is BAN or KICK and taken by moderation authority, end stream if host was targeted
    if (input.targetUserId === stream.hostId && (input.action === 'BAN' || input.action === 'KICK')) {
      await this.prisma.liveStream.update({
        where: { id: input.streamId },
        data: {
          status: LiveStreamStatus.SUSPENDED,
          endedAt: new Date(),
          endedBy: input.moderatorId,
        },
      });
    }

    return actionRow;
  }

  /** Task 31: Get moderation action trail, optionally filtered by targetUserId. */
  async getStreamActions(streamId: string, targetUserId?: string) {
    return this.prisma.live_stream_moderation_actions.findMany({
      where: {
        streamId,
        ...(targetUserId ? { targetUserId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async escalateViolation(streamId: string, moderatorId: string, targetUserId: string, reason: string) {
    const stream = await this.getStream(streamId);
    if (this.scopeService) {
      await this.scopeService.assertModeratorInScope(moderatorId, stream.regionId);
    }

    const actionRow = await this.prisma.live_stream_moderation_actions.create({
      data: {
        id: randomUUID(),
        streamId,
        moderatorId,
        targetUserId,
        action: 'ESCALATE',
        reason: `CRITICAL_ESCALATION: ${reason}`,
      },
    });

    await this.performanceStats.recordAction(moderatorId, 'REPORT_ESCALATED' as any);

    if (this.auditLog) {
      void this.auditLog.logAction({
        actorId: moderatorId,
        action: 'live_stream.escalate_critical_violation',
        resource: 'live_stream',
        resourceId: streamId,
        details: { targetUserId, reason },
      });
    }

    return actionRow;
  }

  // ---- Ephemeral Realtime Presence (Redis-only, Moderator Anonymous) ----

  async joinStream(streamId: string, user: AuthenticatedUser) {
    await this.getStream(streamId);
    const isModerator = (user.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );
    await this.presence.joinLiveStream(streamId, user.id, isModerator);
    const viewerCount = await this.presence.liveStreamViewerCount(streamId);
    return { joined: true, isAnonymousModerator: isModerator, viewerCount };
  }

  async leaveStream(streamId: string, user: AuthenticatedUser) {
    const isModerator = (user.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );
    await this.presence.leaveLiveStream(streamId, user.id, isModerator);
    const viewerCount = await this.presence.liveStreamViewerCount(streamId);
    return { left: true, viewerCount };
  }

  async getStreamViewers(streamId: string) {
    const [viewerIds, count] = await Promise.all([
      this.presence.liveStreamViewers(streamId),
      this.presence.liveStreamViewerCount(streamId),
    ]);
    return { viewerIds, count };
  }
}
