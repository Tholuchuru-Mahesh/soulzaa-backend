import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  LiveStreamModerationBanType,
  LiveStreamModerationMuteType,
  LiveStreamStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { InvestigationRecordingService } from 'src/modules/investigation-recording/services/investigation-recording.service';
import { ModeratorPerformanceService } from 'src/modules/moderator-performance/services/moderator-performance.service';
import { AuditLogService } from 'src/modules/authorization/services/audit-log.service';
import { PresenceService } from 'src/infra/redis/presence.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import {
  WorkforceScopeService,
  type EscalationSeverity,
} from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { recordEscalationOutcome } from 'src/modules/mobile-workforce/services/escalation-recorder.util';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import { LiveStreamModerationRepository } from '../repositories/live-stream-moderation.repository';
import { LiveStreamReportRepository } from '../repositories/live-stream-report.repository';
import {
  LIVE_STREAM_NAMESPACE,
  LIVE_STREAM_SOCKET_EVENTS,
  SYSTEM_MODERATOR_ID,
} from '../constants/live-stream-moderation.constants';
import { PlatformModerationAuditService } from 'src/modules/platform-moderation/services/platform-moderation-audit.service';
import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';

export interface CreateLiveStreamInput {
  hostId: string;
  hostRoles?: string[];
  title?: string;
  description?: string;
}

export interface LiveStreamModerationInput {
  streamId: string;
  moderatorId: string;
  targetUserId: string;
  action: 'WARN' | 'MUTE' | 'KICK' | 'BAN';
  reason?: string;
  /** Minutes until a MUTE/BAN self-lifts. Omit (or <=0) for PERMANENT. Ignored for WARN/KICK. */
  durationMinutes?: number;
  /** Only meaningful for WARN: PRIVATE (default) or ROOM-wide system broadcast. */
  scope?: 'PRIVATE' | 'ROOM';
}

@Injectable()
export class LiveStreamService {
  private readonly logger = new Logger(LiveStreamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly investigationRecording: InvestigationRecordingService,
    private readonly performanceStats: ModeratorPerformanceService,
    private readonly presence: PresenceService,
    private readonly moderationRepo: LiveStreamModerationRepository,
    private readonly sockets: SocketManager,
    private readonly scopeService: WorkforceScopeService,
    @Optional() private readonly auditLog?: AuditLogService,
    @Optional() @Inject(NOTIFICATION_SERVICE) private readonly notifications?: INotificationService,
    @Optional() private readonly reportRepo?: LiveStreamReportRepository,
    @Optional() private readonly platformAudit?: PlatformModerationAuditService,
    @Optional() private readonly platformBans?: PlatformBanService,
  ) {}

  async createStream(input: CreateLiveStreamInput) {
    const isModeratorActor = (input.hostRoles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );
    if (!isModeratorActor && this.platformBans) {
      await this.platformBans.assertNotGloballyBanned(input.hostId);
    }
    // Get host location details if available to populate scope fields
    const host = await this.prisma.user.findUnique({
      where: { id: input.hostId },
      select: { stateId: true, countryId: true },
    });

    return this.prisma.liveStream.create({
      data: {
        id: randomUUID(),
        hostId: input.hostId,
        streamerId: input.hostId,
        title: input.title ?? 'Live Stream',
        description: input.description,
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

  async listStreams(filters: { status?: LiveStreamStatus }, page = 1, limit = 20) {
    const where: Record<string, unknown> = {};
    if (filters.status) where['status'] = filters.status;

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
  async moderateUser(input: LiveStreamModerationInput, requestMeta?: RequestMetadata) {
    const stream = await this.getStream(input.streamId);
    if (stream.status !== LiveStreamStatus.ACTIVE) {
      throw new BadRequestException('Cannot moderate a closed stream');
    }

    await this.scopeService.assertModeratorInScope(input.moderatorId, stream.hostId);

    // 1. Reuse an already-open recording from when the moderator joined to
    // investigate a pending report, if one exists; otherwise open a fresh one.
    const violationReason = input.reason ?? `Live stream moderation: ${input.action}`;
    const existingRecording = await this.investigationRecording.findActiveRecording(
      input.moderatorId,
      input.targetUserId,
      { liveStreamId: input.streamId },
    );
    const recording =
      existingRecording ??
      (await this.investigationRecording.beginRecording({
        moderatorId: input.moderatorId,
        targetUserId: input.targetUserId,
        liveStreamId: input.streamId,
        ownerId: stream.hostId ?? undefined,
        violationReason,
        evidencePayload: {
          streamId: input.streamId,
          hostId: stream.hostId,
          action: input.action,
          timestamp: new Date().toISOString(),
        },
      }));

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

    // 3. Complete investigation recording — passes violationReason through so
    // it backfills a join-triggered row that was opened without one.
    await this.investigationRecording.completeRecording({
      recordingId: recording.id,
      actionTaken: input.action,
      violationReason,
      evidencePayload: { actionId: actionRow.id },
    });

    // 4. Update Moderator KPI stats
    await this.performanceStats.recordAction(input.moderatorId, input.action as any);

    if (this.auditLog) {
      void this.auditLog.logAction({
        actorId: input.moderatorId,
        action: `live_stream.${input.action.toLowerCase()}`,
        resource: 'live_stream',
        resourceId: input.streamId,
        liveStreamId: input.streamId,
        targetUserId: input.targetUserId,
        evidenceId: recording.evidenceId,
        violationReason: input.reason,
        ipAddress: requestMeta?.ip,
        userAgent: requestMeta?.userAgent,
        details: { targetUserId: input.targetUserId, reason: input.reason ?? null },
      });
    }

    // 5. REAL enforcement against the target's live connection — previously
    // this was audit-only for non-host targets (see enforceModerationAction).
    await this.enforceModerationAction(stream.id, input);

    // If action is BAN or KICK and taken by moderation authority, end stream if host was targeted
    if (
      input.targetUserId === stream.hostId &&
      (input.action === 'BAN' || input.action === 'KICK')
    ) {
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

  /**
   * Broadcast an anonymous system warning to everyone in the live stream.
   */
  async broadcastWarning(
    actor: { id: string; roles?: string[] },
    streamId: string,
    reason: string,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    const stream = await this.prisma.liveStream.findUnique({
      where: { id: streamId },
    });
    if (!stream) {
      throw new NotFoundException('Live stream not found.');
    }
    await this.scopeService.assertModeratorInScope(actor.id, stream.hostId);

    const payload = {
      streamId,
      targetUserId: null,
      moderatorId: SYSTEM_MODERATOR_ID,
      systemMessage: reason,
      scope: 'ROOM',
    };

    this.sockets.emitToNamespaceRoom(
      LIVE_STREAM_NAMESPACE,
      streamId,
      LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
      payload,
    );

    if (this.auditLog) {
      void this.auditLog.logAction({
        actorId: actor.id,
        action: 'live_stream.warn_broadcast',
        resource: 'live_stream',
        resourceId: streamId,
        liveStreamId: streamId,
        violationReason: reason,
        ipAddress: requestMeta?.ip,
        userAgent: requestMeta?.userAgent,
        details: { reason },
      });
    }

    if (this.performanceStats) {
      void this.performanceStats.recordAction(actor.id, 'WARN');
    }

    if (this.platformAudit) {
      void this.platformAudit.record({
        moderatorId: actor.id,
        action: 'WARNING_SENT',
        roomType: 'LIVE_STREAM',
        roomId: streamId,
        reason,
        scope: 'ROOM',
      });
    }
  }

  /**
   * Real enforcement — mirrors how Audio/Video Room moderation actually
   * takes effect against a live participant (not just an audit row):
   *  - WARN: an ephemeral `USER_WARNED` socket event, System-attributed.
   *    ROOM scope broadcasts to everyone in the stream; PRIVATE (the
   *    default) targets only the recipient's sockets on `/live`. No durable
   *    row either way — a warning is not a state change.
   *  - MUTE: a durable `LiveStreamMute` row + Redis mirror, checked by
   *    `assertCanSendChat` — the chat-send gate contract a future
   *    live-stream chat feature must call, exactly like the Audio Room's
   *    `ModerationService` mute check.
   *  - KICK: a hard socket disconnect on the `/live` namespace (no durable
   *    row — they may simply rejoin), mirroring Video Room's
   *    `sockets.disconnectUserInNamespace`.
   *  - BAN: KICK's disconnect PLUS a durable `LiveStreamBan` row + Redis
   *    mirror, checked by `joinStream` (the rejoin gate) — mirrors Audio
   *    Room's `RoomBan` / Video Room's `VideoRoomBlock` join-time check.
   * Applies uniformly to host and non-host targets (a strict improvement for
   * the host case: previously a host BAN/KICK suspended the stream but never
   * disconnected the host's own live socket).
   */
  private async enforceModerationAction(
    streamId: string,
    input: LiveStreamModerationInput,
  ): Promise<void> {
    if (input.action === 'WARN') {
      const payload = {
        streamId,
        targetUserId: input.targetUserId,
        moderatorId: SYSTEM_MODERATOR_ID,
        systemMessage: input.reason ?? 'A moderator issued a warning.',
      };
      if (input.scope === 'ROOM') {
        this.sockets.emitToNamespaceRoom(
          LIVE_STREAM_NAMESPACE,
          streamId,
          LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
          payload,
        );
      } else {
        this.sockets.emitToUserInNamespace(
          LIVE_STREAM_NAMESPACE,
          input.targetUserId,
          LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
          payload,
        );
      }
      if (this.platformAudit) {
        void this.platformAudit.record({
          moderatorId: input.moderatorId,
          action: 'WARNING_SENT',
          roomType: 'LIVE_STREAM',
          roomId: streamId,
          targetUserId: input.targetUserId,
          reason: input.reason,
          scope: input.scope,
        });
      }
      return;
    }

    if (input.action === 'MUTE') {
      if (await this.moderationRepo.findActiveMute(streamId, input.targetUserId)) return;
      const expiresAt = this.resolveExpiry(input.durationMinutes);
      await this.moderationRepo.createMute({
        streamId,
        userId: input.targetUserId,
        moderatorId: input.moderatorId,
        type: expiresAt
          ? LiveStreamModerationMuteType.TEMPORARY
          : LiveStreamModerationMuteType.PERMANENT,
        reason: input.reason ?? null,
        expiresAt,
      });
      await this.moderationRepo.addMuteMirror(
        streamId,
        input.targetUserId,
        expiresAt ? expiresAt.getTime() - Date.now() : null,
      );
      this.broadcastSystemMessage(
        streamId,
        LIVE_STREAM_SOCKET_EVENTS.USER_MUTED,
        input.targetUserId,
      );
      return;
    }

    if (input.action === 'KICK') {
      this.sockets.disconnectUserInNamespace(LIVE_STREAM_NAMESPACE, input.targetUserId);
      this.broadcastSystemMessage(
        streamId,
        LIVE_STREAM_SOCKET_EVENTS.USER_KICKED,
        input.targetUserId,
      );
      return;
    }

    if (input.action === 'BAN') {
      if (!(await this.moderationRepo.findActiveBan(streamId, input.targetUserId))) {
        const expiresAt = this.resolveExpiry(input.durationMinutes);
        await this.moderationRepo.createBan({
          streamId,
          userId: input.targetUserId,
          moderatorId: input.moderatorId,
          type: expiresAt
            ? LiveStreamModerationBanType.TEMPORARY
            : LiveStreamModerationBanType.PERMANENT,
          reason: input.reason ?? null,
          expiresAt,
        });
        await this.moderationRepo.addBanMirror(
          streamId,
          input.targetUserId,
          expiresAt ? expiresAt.getTime() - Date.now() : null,
        );
      }
      this.sockets.disconnectUserInNamespace(LIVE_STREAM_NAMESPACE, input.targetUserId);
      // Proactively drop them from the viewer presence set — they're banned, not just kicked.
      await this.presence.leaveLiveStream(streamId, input.targetUserId, false);
      this.broadcastSystemMessage(
        streamId,
        LIVE_STREAM_SOCKET_EVENTS.USER_BANNED,
        input.targetUserId,
      );
    }
  }

  /**
   * Anonymity (spec): "Whenever a moderation action occurs, users should only
   * see system messages" — never the moderator's identity. Mirrors Audio
   * Room's `ModerationSocketListener.anonymize()` / Video Room's equivalent:
   * the real moderatorId never leaves this service, the broadcast carries
   * only `SYSTEM_MODERATOR_ID` and a generic message.
   */
  private broadcastSystemMessage(streamId: string, event: string, targetUserId: string): void {
    this.sockets.emitToNamespaceRoom(LIVE_STREAM_NAMESPACE, streamId, event, {
      streamId,
      targetUserId,
      moderatorId: SYSTEM_MODERATOR_ID,
      systemMessage: 'A moderator took action on this user for violating community guidelines.',
    });
  }

  private resolveExpiry(durationMinutes?: number): Date | null {
    if (!durationMinutes || durationMinutes <= 0) return null;
    return new Date(Date.now() + durationMinutes * 60_000);
  }

  /**
   * The chat-send gate a live-stream chat feature must call before accepting
   * a message — mirrors Audio Room's mute check contract. No live-stream
   * chat feature exists yet in this codebase to call it from; this is the
   * enforcement primitive ready for it.
   */
  async assertCanSendChat(streamId: string, userId: string): Promise<void> {
    if (await this.moderationRepo.isActivelyMuted(streamId, userId)) {
      throw new ForbiddenException('You are muted in this live stream and cannot send messages.');
    }
  }

  async isMuted(streamId: string, userId: string): Promise<boolean> {
    return this.moderationRepo.isActivelyMuted(streamId, userId);
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

  async escalateViolation(
    streamId: string,
    moderatorId: string,
    targetUserId: string,
    reason: string,
    severity: EscalationSeverity,
  ) {
    const stream = await this.getStream(streamId);
    await this.scopeService.assertModeratorInScope(moderatorId, stream.hostId);

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

    await recordEscalationOutcome({
      actorId: moderatorId,
      targetUserId,
      reason,
      severity,
      auditAction: 'live_stream.escalate_critical_violation',
      resource: 'live_stream',
      resourceId: streamId,
      ownerId: stream.hostId,
      performanceStats: this.performanceStats,
      auditLog: this.auditLog,
      scopeService: this.scopeService,
      notifications: this.notifications,
    });

    return actionRow;
  }

  // ---- Ephemeral Realtime Presence (Redis-only, Moderator Anonymous) ----

  async joinStream(streamId: string, user: AuthenticatedUser) {
    const stream = await this.getStream(streamId);
    const isModerator = (user.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );

    if (!isModerator && this.platformBans) {
      await this.platformBans.assertNotGloballyBanned(user.id);
    }

    // The rejoin gate: a banned non-moderator viewer cannot come back until
    // the ban is lifted or expires. Mirrors Audio Room's ban check / Video
    // Room's findActiveBlock join-time check.
    if (!isModerator && (await this.moderationRepo.isActivelyBanned(streamId, user.id))) {
      throw new ForbiddenException('You are banned from this live stream.');
    }

    await this.presence.joinLiveStream(streamId, user.id, isModerator);
    const viewerCount = await this.presence.liveStreamViewerCount(streamId);

    if (isModerator) {
      if (this.performanceStats) {
        void this.performanceStats.recordAction(user.id, 'ROOM_VISITED');
      }
      if (this.investigationRecording && this.reportRepo) {
        void this.reportRepo.listPendingReports(streamId).then((reports) =>
          Promise.all(
            reports.map((report) =>
              this.investigationRecording.beginOrReuseRecording({
                moderatorId: user.id,
                targetUserId: report.targetUserId,
                liveStreamId: streamId,
                ownerId: stream.hostId ?? undefined,
                evidencePayload: { streamId, reportId: report.id, trigger: 'stream_join' },
              }),
            ),
          ),
        );
      }
      if (this.platformAudit) {
        void this.platformAudit.record({
          moderatorId: user.id,
          action: 'INCOGNITO_JOIN',
          roomType: 'LIVE_STREAM',
          roomId: streamId,
        });
      }
    }

    return { joined: true, isAnonymousModerator: isModerator, viewerCount };
  }

  async leaveStream(streamId: string, user: AuthenticatedUser) {
    const isModerator = (user.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );
    await this.presence.leaveLiveStream(streamId, user.id, isModerator);
    const viewerCount = await this.presence.liveStreamViewerCount(streamId);

    if (isModerator && this.platformAudit) {
      void this.platformAudit.record({
        moderatorId: user.id,
        action: 'INCOGNITO_LEAVE',
        roomType: 'LIVE_STREAM',
        roomId: streamId,
      });
    }

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
