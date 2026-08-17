import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  AudioRoom,
  ModerationActionType,
  ModerationBanType,
  ModerationMuteType,
  ReportReason,
  RoomBan,
  RoomKick,
  RoomMute,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import { PresenceService } from 'src/infra/redis/presence.service';
import { moderationLockKey, SYSTEM_MODERATOR_ID } from '../constants/moderation.constants';
import type { BanDto } from '../dto/moderation.dto';
import type { ListModerationDto } from '../dto/moderation.dto';
import type { MuteDto } from '../dto/moderation.dto';
import type { ReportDto } from '../dto/moderation.dto';
import type { ReviewReportDto } from '../dto/moderation.dto';
import type { AppealDto } from '../dto/moderation.dto';
import type { ResolveAppealDto } from '../dto/moderation.dto';
import { RoomLeftEvent } from '../events/audio-room.events';
import {
  AppealResolvedEvent,
  AppealSubmittedEvent,
  MemberBannedEvent,
  MemberKickedEvent,
  MemberMutedEvent,
  MemberReportedEvent,
  MemberUnbannedEvent,
  MemberUnkickedEvent,
  MemberUnmutedEvent,
  MemberWarnedEvent,
} from '../events/audio-room-moderation.events';
import type { IModerationService } from '../interfaces/moderation.service.interface';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomSeatsRepository } from '../repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import {
  ModerationRepository,
  type ModeratedUserSummary,
} from '../repositories/moderation.repository';
import { RoomPermissionService } from './room-permission.service';
import { VoiceService } from './voice.service';
import { InvestigationRecordingService } from 'src/modules/investigation-recording/services/investigation-recording.service';
import { ModeratorPerformanceService } from 'src/modules/moderator-performance/services/moderator-performance.service';
import { AuditLogService } from 'src/modules/authorization/services/audit-log.service';
import {
  WorkforceScopeService,
  type EscalationSeverity,
} from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { recordEscalationOutcome } from 'src/modules/mobile-workforce/services/escalation-recorder.util';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import { ModeratorNotificationService } from 'src/modules/moderator-shift/services/moderator-notification.service';
import { ModerationApprovalService } from 'src/modules/moderation-approval/services/moderation-approval.service';
import {
  buildReportReviewReason,
  recordReportResolutionIfConfigured,
} from 'src/modules/moderation-approval/utils/report-review-outcome.util';

/** Report reasons that page a moderator immediately rather than waiting in the normal report queue. */
const HIGH_PRIORITY_REPORT_REASONS: ReportReason[] = [
  ReportReason.THREATS,
  ReportReason.SEXUAL_CONTENT,
];

/**
 * A Kick List row, hydrated with the display data the moderator UI needs: who was
 * kicked (avatar + username), who kicked them, why, and when.
 */
export interface RoomKickView {
  id: string;
  roomId: string;
  targetUserId: string;
  targetUsername: string | null;
  targetAvatarKey: string | null;
  moderatorId: string;
  moderatorUsername: string | null;
  reason: string | null;
  createdAt: Date;
}

/**
 * AR-3 moderation: kick, temporary/permanent ban, member mute (incl. permanent),
 * report, notes, appeals — with a role-hierarchy guard, immutable audit
 * (moderation_actions), Redis-synchronised enforcement, and realtime broadcasts.
 * Every action asserts the actor may moderate + outranks the target, runs under
 * a per-room lock, writes durable state + the audit row, updates Redis, publishes
 * a domain event (bridged to sockets), and notifies affected users.
 */
@Injectable()
export class ModerationService implements IModerationService {
  constructor(
    private readonly repo: ModerationRepository,
    private readonly permissions: RoomPermissionService,
    private readonly rooms: AudioRoomsRepository,
    private readonly seats: AudioRoomSeatsRepository,
    private readonly presence: PresenceService,
    private readonly voice: VoiceService,
    private readonly locks: LockService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly scopeService: WorkforceScopeService,
    @Optional() private readonly investigationRecording?: InvestigationRecordingService,
    @Optional() private readonly performanceStats?: ModeratorPerformanceService,
    @Optional() private readonly auditLog?: AuditLogService,
    @Optional() @Inject(NOTIFICATION_SERVICE) private readonly notifications?: INotificationService,
    @Optional() private readonly moderatorNotify?: ModeratorNotificationService,
    @Optional() private readonly approvalService?: ModerationApprovalService,
  ) {}

  // ======================= Kick / restore (the Kick List) =======================

  /**
   * Kick a member: remove them from the room now and add them to the room's Kick
   * List, which bars them from rejoining until a moderator restores them. The
   * durable row (room_kicks) is authoritative; Redis mirrors it for the join gate.
   */
  async kick(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    reason?: string,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    await this.assertModerationPrereqs(roomId, actor, targetUserId);
    await this.locks.withLock(moderationLockKey(roomId), async () => {
      const member = await this.rooms.getMember(roomId, targetUserId);
      if (!member?.isActive) {
        throw new BusinessException(
          ERROR_CODES.NOT_ROOM_MEMBER,
          'That user is not in the room.',
          HttpStatus.CONFLICT,
        );
      }
      // An active member cannot already hold an ACTIVE kick (the join gate would
      // have blocked them), but stay idempotent rather than stacking rows.
      const existing = await this.repo.findActiveKick(roomId, targetUserId);
      const kick =
        existing ??
        (await this.repo.createKick({
          roomId,
          userId: targetUserId,
          moderatorId: actor.id,
          reason: reason ?? null,
        }));
      await this.repo.addKickCache(roomId, targetUserId);

      await this.removeFromRoom(roomId, targetUserId, actor.id);
      await this.repo.appendAction({
        roomId,
        moderatorId: actor.id,
        targetUserId,
        action: ModerationActionType.KICK,
        reason: reason ?? null,
        metadata: { kickId: kick.id },
      });

      // Hook InvestigationRecording & Performance KPI
      let evidenceId: string | undefined;
      if (this.investigationRecording) {
        const violationReason = reason ?? 'Audio room kick';
        const existingRecording = await this.investigationRecording.findActiveRecording(
          actor.id,
          targetUserId,
          { roomId },
        );
        const rec =
          existingRecording ??
          (await this.investigationRecording.beginRecording({
            moderatorId: actor.id,
            targetUserId,
            roomId,
            violationReason,
            evidencePayload: { roomId, action: 'KICK', kickId: kick.id },
          }));
        if (rec) {
          evidenceId = rec.evidenceId;
          void this.investigationRecording.completeRecording({
            recordingId: rec.id,
            actionTaken: 'KICK',
            violationReason,
          });
        }
      }
      if (this.performanceStats) {
        void this.performanceStats.recordAction(actor.id, 'KICK');
      }
      if (this.auditLog) {
        void this.auditLog.logAction({
          actorId: actor.id,
          action: 'audio_room.kick',
          resource: 'audio_room',
          resourceId: roomId,
          targetUserId,
          violationReason: reason,
          evidenceId,
          ipAddress: requestMeta?.ip,
          userAgent: requestMeta?.userAgent,
          details: { targetUserId, reason: reason ?? null },
        });
      }
    });
    await this.bus.publish(
      new MemberKickedEvent({
        roomId,
        moderatorId: actor.id,
        targetUserId,
        reason: reason ?? null,
      }),
    );
    await this.notifyUser(targetUserId, 'audio_room.kicked', { roomId, reason: reason ?? null });
  }

  /**
   * Restore ("unkick") a user: lift their ACTIVE kick so they may rejoin the room.
   * Like unban/unmute this is a restorative action, so it only requires moderator
   * authority — no self-check, and no outranks check (the target left the room and
   * therefore holds no role to outrank).
   */
  async unkick(actor: RoomActor, roomId: string, targetUserId: string): Promise<void> {
    await this.permissions.assertCanModerate(roomId, actor);
    const room = await this.requireRoom(roomId);
    await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    const kick = await this.repo.findActiveKick(roomId, targetUserId);
    if (!kick) {
      throw new BusinessException(
        ERROR_CODES.KICK_NOT_FOUND,
        'That user is not on the kick list.',
        HttpStatus.NOT_FOUND,
      );
    }

    await this.repo.liftKick(kick.id, actor.id);
    await this.repo.removeKickCache(roomId, targetUserId);
    await this.repo.appendAction({
      roomId,
      moderatorId: actor.id,
      targetUserId,
      action: ModerationActionType.UNKICK,
      metadata: { kickId: kick.id },
    });
    await this.bus.publish(
      new MemberUnkickedEvent({
        roomId,
        moderatorId: actor.id,
        targetUserId,
        kickId: kick.id,
      }),
    );
    await this.notifyUser(targetUserId, 'audio_room.unkicked', { roomId });
  }

  // ======================= Ban / unban =======================

  async ban(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    dto: BanDto,
    requestMeta?: RequestMetadata,
  ): Promise<RoomBan> {
    await this.assertModerationPrereqs(roomId, actor, targetUserId);
    const expiresAt = this.resolveExpiry(
      dto.type === ModerationBanType.TEMPORARY,
      dto.durationMinutes,
    );

    return this.locks.withLock(moderationLockKey(roomId), async () => {
      if (await this.repo.findActiveBan(roomId, targetUserId)) {
        throw new BusinessException(
          ERROR_CODES.ALREADY_BANNED,
          'That user is already banned from this room.',
          HttpStatus.CONFLICT,
        );
      }
      const ban = await this.repo.createBan({
        roomId,
        userId: targetUserId,
        moderatorId: actor.id,
        type: dto.type,
        reason: dto.reason ?? null,
        expiresAt,
      });
      await this.repo.addBanCache(
        roomId,
        targetUserId,
        expiresAt ? expiresAt.getTime() - Date.now() : null,
      );

      // Remove them from the room now (kick as part of the ban).
      const member = await this.rooms.getMember(roomId, targetUserId);
      if (member?.isActive) await this.removeFromRoom(roomId, targetUserId, actor.id);

      await this.repo.appendAction({
        roomId,
        moderatorId: actor.id,
        targetUserId,
        action:
          dto.type === ModerationBanType.PERMANENT
            ? ModerationActionType.BAN_PERMANENT
            : ModerationActionType.BAN_TEMPORARY,
        reason: dto.reason ?? null,
        metadata: { banId: ban.id, expiresAt: expiresAt?.toISOString() ?? null },
      });

      let evidenceId: string | undefined;
      if (this.investigationRecording) {
        const violationReason = dto.reason ?? 'Audio room ban';
        const existing = await this.investigationRecording.findActiveRecording(
          actor.id,
          targetUserId,
          { roomId },
        );
        const rec =
          existing ??
          (await this.investigationRecording.beginRecording({
            moderatorId: actor.id,
            targetUserId,
            roomId,
            violationReason,
            evidencePayload: { roomId, action: 'BAN', banId: ban.id },
          }));
        if (rec) {
          evidenceId = rec.evidenceId;
          void this.investigationRecording.completeRecording({
            recordingId: rec.id,
            actionTaken: 'BAN',
            violationReason,
          });
        }
      }
      if (this.performanceStats) {
        void this.performanceStats.recordAction(actor.id, 'BAN');
      }
      if (this.auditLog) {
        void this.auditLog.logAction({
          actorId: actor.id,
          action: `audio_room.ban_${dto.type.toLowerCase()}`,
          resource: 'audio_room',
          resourceId: roomId,
          targetUserId,
          violationReason: dto.reason,
          evidenceId,
          ipAddress: requestMeta?.ip,
          userAgent: requestMeta?.userAgent,
          details: {
            targetUserId,
            reason: dto.reason ?? null,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        });
      }

      await this.bus.publish(
        new MemberBannedEvent({
          roomId,
          moderatorId: actor.id,
          targetUserId,
          type: dto.type,
          reason: dto.reason ?? null,
          expiresAt: expiresAt?.toISOString() ?? null,
        }),
      );
      await this.notifyUser(targetUserId, 'audio_room.banned', {
        roomId,
        type: dto.type,
        expiresAt: expiresAt?.toISOString() ?? null,
      });
      return ban;
    });
  }

  async unban(actor: RoomActor, roomId: string, targetUserId: string): Promise<void> {
    await this.permissions.assertCanModerate(roomId, actor);
    const room = await this.requireRoom(roomId);
    await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    const ban = await this.repo.findActiveBan(roomId, targetUserId);
    if (!ban) {
      throw new BusinessException(
        ERROR_CODES.BAN_NOT_FOUND,
        'No active ban found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.liftBanInternal(ban, actor.id, 'LIFTED', 'lifted');
  }

  // ======================= Mute / unmute =======================

  async mute(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    dto: MuteDto,
    requestMeta?: RequestMetadata,
  ): Promise<RoomMute> {
    await this.assertModerationPrereqs(roomId, actor, targetUserId);
    const expiresAt = this.resolveExpiry(
      dto.type === ModerationMuteType.TEMPORARY,
      dto.durationMinutes,
    );

    return this.locks.withLock(moderationLockKey(roomId), async () => {
      if (await this.repo.findActiveMute(roomId, targetUserId)) {
        throw new BusinessException(
          ERROR_CODES.ALREADY_MUTED,
          'That user is already muted.',
          HttpStatus.CONFLICT,
        );
      }
      const mute = await this.repo.createMute({
        roomId,
        userId: targetUserId,
        moderatorId: actor.id,
        type: dto.type,
        reason: dto.reason ?? null,
        expiresAt,
      });
      await this.repo.addMuteCache(
        roomId,
        targetUserId,
        expiresAt ? expiresAt.getTime() - Date.now() : null,
      );
      await this.voice.forceMute(roomId, targetUserId, true);

      await this.repo.appendAction({
        roomId,
        moderatorId: actor.id,
        targetUserId,
        action:
          dto.type === ModerationMuteType.PERMANENT
            ? ModerationActionType.MUTE_PERMANENT
            : ModerationActionType.MUTE_TEMPORARY,
        reason: dto.reason ?? null,
        metadata: { muteId: mute.id, expiresAt: expiresAt?.toISOString() ?? null },
      });
      let evidenceId: string | undefined;
      if (this.investigationRecording) {
        const violationReason = dto.reason ?? 'Audio room mute violation';
        const existing = await this.investigationRecording.findActiveRecording(
          actor.id,
          targetUserId,
          { roomId },
        );
        const rec =
          existing ??
          (await this.investigationRecording.beginRecording({
            moderatorId: actor.id,
            targetUserId,
            roomId,
            violationReason,
          }));
        if (rec) {
          evidenceId = rec.evidenceId;
          void this.investigationRecording.completeRecording({
            recordingId: rec.id,
            actionTaken: 'MUTE',
            violationReason,
          });
        }
      }
      if (this.auditLog) {
        void this.auditLog.logAction({
          actorId: actor.id,
          action: `audio_room.mute_${dto.type.toLowerCase()}`,
          resource: 'audio_room',
          resourceId: roomId,
          targetUserId,
          violationReason: dto.reason,
          evidenceId,
          ipAddress: requestMeta?.ip,
          userAgent: requestMeta?.userAgent,
          details: {
            targetUserId,
            reason: dto.reason ?? null,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        });
      }
      if (this.performanceStats) {
        void this.performanceStats.recordAction(actor.id, 'MUTE');
      }
      await this.bus.publish(
        new MemberMutedEvent({
          roomId,
          moderatorId: actor.id,
          targetUserId,
          type: dto.type,
          reason: dto.reason ?? null,
          expiresAt: expiresAt?.toISOString() ?? null,
        }),
      );
      return mute;
    });
  }

  async unmute(actor: RoomActor, roomId: string, targetUserId: string): Promise<void> {
    await this.permissions.assertCanModerate(roomId, actor);
    const room = await this.requireRoom(roomId);
    await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    const mute = await this.repo.findActiveMute(roomId, targetUserId);
    if (!mute) {
      throw new BusinessException(
        ERROR_CODES.MUTE_NOT_FOUND,
        'No active mute found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.liftMuteInternal(mute, actor.id, 'LIFTED', 'lifted');
  }

  // ======================= Warn =======================

  async warn(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    reason: string,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    await this.assertModerationPrereqs(roomId, actor, targetUserId);
    let evidenceId: string | undefined;
    if (this.investigationRecording) {
      const existing = await this.investigationRecording.findActiveRecording(
        actor.id,
        targetUserId,
        { roomId },
      );
      const rec =
        existing ??
        (await this.investigationRecording.beginRecording({
          moderatorId: actor.id,
          targetUserId,
          roomId,
          violationReason: reason,
        }));
      if (rec) {
        evidenceId = rec.evidenceId;
        void this.investigationRecording.completeRecording({
          recordingId: rec.id,
          actionTaken: 'WARN',
          violationReason: reason,
        });
      }
    }
    await this.repo.appendAction({
      roomId,
      moderatorId: actor.id,
      targetUserId,
      action: ModerationActionType.WARN,
      reason,
    });
    if (this.auditLog) {
      void this.auditLog.logAction({
        actorId: actor.id,
        action: 'audio_room.warn',
        resource: 'audio_room',
        resourceId: roomId,
        targetUserId,
        violationReason: reason,
        evidenceId,
        ipAddress: requestMeta?.ip,
        userAgent: requestMeta?.userAgent,
        details: { targetUserId, reason },
      });
    }
    if (this.performanceStats) {
      void this.performanceStats.recordAction(actor.id, 'WARN');
    }
    await this.bus.publish(
      new MemberWarnedEvent({ roomId, moderatorId: actor.id, targetUserId, reason }),
    );
    await this.notifyUser(targetUserId, 'audio_room.warned', { roomId, reason });
  }

  // ======================= Reports =======================

  async report(reporter: RoomActor, roomId: string, dto: ReportDto) {
    if (dto.targetUserId === reporter.id) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_MODERATE_SELF,
        'You cannot report yourself.',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.requireRoom(roomId);
    if (await this.repo.findOpenReport(roomId, reporter.id, dto.targetUserId)) {
      throw new BusinessException(
        ERROR_CODES.DUPLICATE_REPORT,
        'You already have a pending report against this user.',
        HttpStatus.CONFLICT,
      );
    }
    const report = await this.repo.createReport({
      roomId,
      reporterId: reporter.id,
      targetUserId: dto.targetUserId,
      reason: dto.reason,
      description: dto.description ?? null,
    });
    const recipientIds = await this.moderatorRecipients(roomId, reporter.id);
    await this.bus.publish(
      new MemberReportedEvent({
        roomId,
        reportId: report.id,
        reporterId: reporter.id,
        targetUserId: dto.targetUserId,
        reason: dto.reason,
        recipientIds,
      }),
    );
    await this.queue.enqueue(QUEUE_NAMES.NOTIFICATIONS, 'moderation.report', {
      roomId,
      reportId: report.id,
      recipientIds,
    });
    if (this.moderatorNotify && HIGH_PRIORITY_REPORT_REASONS.includes(dto.reason)) {
      await Promise.all(
        recipientIds.map((moderatorId) =>
          this.moderatorNotify!.notifyHighPriorityReport(moderatorId, report.id, dto.reason),
        ),
      );
    }
    return report;
  }

  /** Assigns a PENDING report to a moderator, opening it as their investigation. */
  async assignReport(
    actor: RoomActor,
    roomId: string,
    reportId: string,
    assigneeId: string,
  ): Promise<void> {
    await this.permissions.assertCanModerate(roomId, actor);
    const room = await this.requireRoom(roomId);
    await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    const report = await this.repo.getReport(reportId);
    if (!report || report.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.REPORT_NOT_FOUND,
        'Report not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (report.status !== 'PENDING') {
      throw new BusinessException(
        ERROR_CODES.REPORT_NOT_FOUND,
        'That report has already been reviewed.',
        HttpStatus.CONFLICT,
      );
    }
    await this.repo.assignReport(reportId, assigneeId);
    if (this.moderatorNotify) {
      await this.moderatorNotify.notifyReportAssigned(assigneeId, reportId, actor.id);
    }
  }

  async reviewReport(
    actor: RoomActor,
    roomId: string,
    reportId: string,
    dto: ReviewReportDto,
  ): Promise<void> {
    await this.permissions.assertCanModerate(roomId, actor);
    const room = await this.requireRoom(roomId);
    await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    const report = await this.repo.getReport(reportId);
    if (!report || report.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.REPORT_NOT_FOUND,
        'Report not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (report.status !== 'PENDING') {
      throw new BusinessException(
        ERROR_CODES.REPORT_NOT_FOUND,
        'Report has already been reviewed.',
        HttpStatus.CONFLICT,
      );
    }
    await this.repo.reviewReport(reportId, actor.id, dto.status, dto.resolution ?? null);
    await this.repo.appendAction({
      roomId,
      moderatorId: actor.id,
      targetUserId: report.targetUserId,
      action: ModerationActionType.REPORT_REVIEWED,
      reason: dto.resolution ?? null,
      metadata: { reportId, status: dto.status, recommendedAction: dto.recommendedAction ?? null },
    });

    if (dto.recommendedAction) {
      // Tagged distinctly from a live in-room action: this action was decided
      // during asynchronous report review, not while the moderator was
      // observing the room in real time. The moderator already has direct
      // mute/kick/ban authority (Room Moderation section of the spec), so
      // this executes immediately — the tag is audit-trail clarity, not a
      // gate.
      const reason = buildReportReviewReason(reportId, dto.resolution, dto.recommendedAction);
      if (dto.recommendedAction === 'WARNING') {
        await this.warn(actor, roomId, report.targetUserId, reason);
      } else if (dto.recommendedAction === 'MUTE') {
        await this.mute(actor, roomId, report.targetUserId, {
          type: ModerationMuteType.PERMANENT,
          reason,
        });
      } else if (dto.recommendedAction === 'KICK') {
        await this.kick(actor, roomId, report.targetUserId, reason);
      } else if (dto.recommendedAction === 'BAN') {
        // A recommended BAN is hard to reverse, so it does not auto-execute
        // like the other three actions — it goes to the Official covering
        // the room owner's territory as a pending approval instead (see
        // ModerationApprovalService). If the approval service isn't wired,
        // the recommendation is left unactioned rather than silently
        // executing without the review it needs.
        if (this.approvalService) {
          await this.approvalService.propose({
            roomType: 'AUDIO_ROOM',
            roomId,
            reportId,
            proposedBy: actor.id,
            targetUserId: report.targetUserId,
            reason,
            ownerId: room.ownerId,
          });
        }
      }
    }

    await recordReportResolutionIfConfigured(this.performanceStats, actor.id, report.createdAt);
  }

  async addReportNotes(
    actor: RoomActor,
    roomId: string,
    reportId: string,
    notes: string,
  ): Promise<void> {
    await this.permissions.assertCanModerate(roomId, actor);
    const room = await this.requireRoom(roomId);
    await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    // The scope check above authorizes `roomId`, so the report being mutated
    // must actually belong to that room — otherwise a moderator scoped to
    // this room could pass any out-of-scope room's reportId and edit it.
    const report = await this.repo.getReport(reportId);
    if (!report || report.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.REPORT_NOT_FOUND,
        'Report not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.repo.updateReportNotes(reportId, actor.id, notes);
    await this.repo.appendAction({
      roomId,
      moderatorId: actor.id,
      targetUserId: null,
      action: ModerationActionType.NOTE_ADDED,
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
    await this.permissions.assertCanModerate(roomId, actor);
    const room = await this.requireRoom(roomId);
    await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    // Same binding as `reviewReport`/`assignReport`: the scope check
    // authorized `roomId`, so the report must belong to that room.
    const report = await this.repo.getReport(reportId);
    if (!report || report.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.REPORT_NOT_FOUND,
        'Report not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.repo.dismissReport(reportId, actor.id, reason);
    await this.repo.appendAction({
      roomId,
      moderatorId: actor.id,
      targetUserId: null,
      action: ModerationActionType.REPORT_REVIEWED,
      reason: reason ?? 'Dismissed as false report',
      metadata: { reportId, status: 'DISMISSED' },
    });
    if (this.performanceStats) {
      const resolutionMinutes = (Date.now() - report.createdAt.getTime()) / 60_000;
      await this.performanceStats.recordReportResolution(actor.id, resolutionMinutes);
    }
  }

  async escalateViolation(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    reason: string,
    severity: EscalationSeverity,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    // `assertModerationPrereqs` already 404s on a missing room via
    // `requireRoom`, so this second read is guaranteed to resolve.
    await this.assertModerationPrereqs(roomId, actor, targetUserId);
    const room = await this.requireRoom(roomId);

    await this.repo.appendAction({
      roomId,
      moderatorId: actor.id,
      targetUserId,
      action: ModerationActionType.REPORT_REVIEWED,
      reason: `CRITICAL_ESCALATION: ${reason}`,
      metadata: { escalated: true, targetUserId, severity },
    });

    await recordEscalationOutcome({
      actorId: actor.id,
      targetUserId,
      reason,
      severity,
      auditAction: 'audio_room.escalate_critical_violation',
      resource: 'audio_room',
      resourceId: roomId,
      ownerId: room.ownerId,
      requestMeta,
      performanceStats: this.performanceStats,
      auditLog: this.auditLog,
      scopeService: this.scopeService,
      notifications: this.notifications,
    });
  }

  // ======================= Notes =======================

  async addNote(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    note: string,
  ): Promise<void> {
    await this.permissions.assertCanModerate(roomId, actor);
    await this.repo.addNote({ roomId, targetUserId, authorId: actor.id, note });
    await this.repo.appendAction({
      roomId,
      moderatorId: actor.id,
      targetUserId,
      action: ModerationActionType.NOTE_ADDED,
    });
  }

  // ======================= Appeals =======================

  async submitAppeal(user: RoomActor, roomId: string, dto: AppealDto) {
    if (!!dto.banId === !!dto.muteId) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Provide exactly one of banId or muteId.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (dto.banId) {
      const ban = await this.repo.getBan(dto.banId);
      if (!ban || ban.roomId !== roomId || ban.userId !== user.id || ban.status !== 'ACTIVE') {
        throw new BusinessException(
          ERROR_CODES.BAN_NOT_FOUND,
          'No active ban to appeal.',
          HttpStatus.NOT_FOUND,
        );
      }
    } else {
      const mute = await this.repo.getMute(dto.muteId!);
      if (!mute || mute.roomId !== roomId || mute.userId !== user.id || mute.status !== 'ACTIVE') {
        throw new BusinessException(
          ERROR_CODES.MUTE_NOT_FOUND,
          'No active mute to appeal.',
          HttpStatus.NOT_FOUND,
        );
      }
    }
    if (await this.repo.findPendingAppeal({ banId: dto.banId, muteId: dto.muteId })) {
      throw new BusinessException(
        ERROR_CODES.APPEAL_EXISTS,
        'An appeal for this action is already pending.',
        HttpStatus.CONFLICT,
      );
    }
    const appeal = await this.repo.createAppeal({
      roomId,
      userId: user.id,
      banId: dto.banId ?? null,
      muteId: dto.muteId ?? null,
      reason: dto.reason,
    });
    await this.repo.appendAction({
      roomId,
      moderatorId: null,
      targetUserId: user.id,
      action: ModerationActionType.APPEAL_SUBMITTED,
      reason: dto.reason,
      metadata: { appealId: appeal.id, banId: dto.banId ?? null, muteId: dto.muteId ?? null },
    });
    const recipientIds = await this.moderatorRecipients(roomId, user.id);
    await this.bus.publish(
      new AppealSubmittedEvent({ roomId, appealId: appeal.id, userId: user.id, recipientIds }),
    );
    await this.queue.enqueue(QUEUE_NAMES.NOTIFICATIONS, 'moderation.appeal', {
      roomId,
      appealId: appeal.id,
      recipientIds,
    });
    return appeal;
  }

  async resolveAppeal(
    actor: RoomActor,
    roomId: string,
    appealId: string,
    dto: ResolveAppealDto,
  ): Promise<void> {
    await this.permissions.assertCanModerate(roomId, actor);
    const room = await this.requireRoom(roomId);
    await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
    const appeal = await this.repo.getAppeal(appealId);
    if (!appeal || appeal.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.APPEAL_NOT_FOUND,
        'Appeal not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (appeal.status !== 'PENDING') {
      throw new BusinessException(
        ERROR_CODES.APPEAL_NOT_FOUND,
        'Appeal already resolved.',
        HttpStatus.CONFLICT,
      );
    }
    await this.repo.resolveAppeal(appealId, actor.id, dto.approve, dto.decisionNote ?? null);
    await this.repo.appendAction({
      roomId,
      moderatorId: actor.id,
      targetUserId: appeal.userId,
      action: dto.approve
        ? ModerationActionType.APPEAL_APPROVED
        : ModerationActionType.APPEAL_REJECTED,
      reason: dto.decisionNote ?? null,
      metadata: { appealId },
    });

    if (dto.approve) {
      if (appeal.banId) {
        const ban = await this.repo.getBan(appeal.banId);
        if (ban) {
          if (ban.status === 'ACTIVE') {
            await this.liftBanInternal(ban, actor.id, 'LIFTED', 'appeal_approved');
          }
          // Upheld appeal ⇒ the original ban was wrong, regardless of
          // whether it was still active or had already expired/been lifted.
          if (this.performanceStats) {
            await this.performanceStats.recordFalseModeration(ban.moderatorId);
          }
        }
      } else if (appeal.muteId) {
        const mute = await this.repo.getMute(appeal.muteId);
        if (mute) {
          if (mute.status === 'ACTIVE') {
            await this.liftMuteInternal(mute, actor.id, 'LIFTED', 'appeal_approved');
          }
          if (this.performanceStats) {
            await this.performanceStats.recordFalseModeration(mute.moderatorId);
          }
        }
      }
    }
    await this.bus.publish(
      new AppealResolvedEvent({ roomId, appealId, userId: appeal.userId, approved: dto.approve }),
    );
  }

  // ======================= Expiry (called by the monitor) =======================

  async expireBan(ban: RoomBan): Promise<void> {
    await this.liftBanInternal(ban, ban.moderatorId, 'EXPIRED', 'expired');
  }

  async expireMute(mute: RoomMute): Promise<void> {
    await this.liftMuteInternal(mute, mute.moderatorId, 'EXPIRED', 'expired');
  }

  // ======================= System-initiated escalation (AR-4) =======================

  /**
   * System-initiated temporary mute with no actor authorisation — invoked by the
   * chat blocked-word violation flow when a user crosses the auto-mute threshold.
   * Idempotent: a no-op when the user already has an active mute. Records the
   * durable audit row as `CHAT_AUTO_MUTED` with a null moderator.
   */
  async autoMute(
    roomId: string,
    userId: string,
    reason: string,
    durationMinutes: number,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + Math.max(1, durationMinutes) * 60_000);
    await this.locks.withLock(moderationLockKey(roomId), async () => {
      if (await this.repo.findActiveMute(roomId, userId)) return;
      const mute = await this.repo.createMute({
        roomId,
        userId,
        moderatorId: SYSTEM_MODERATOR_ID,
        type: ModerationMuteType.TEMPORARY,
        reason,
        expiresAt,
      });
      await this.repo.addMuteCache(roomId, userId, expiresAt.getTime() - Date.now());
      await this.voice.forceMute(roomId, userId, true);
      await this.repo.appendAction({
        roomId,
        moderatorId: null,
        targetUserId: userId,
        action: ModerationActionType.CHAT_AUTO_MUTED,
        reason,
        metadata: { muteId: mute.id, expiresAt: expiresAt.toISOString(), system: true },
      });
      await this.bus.publish(
        new MemberMutedEvent({
          roomId,
          moderatorId: SYSTEM_MODERATOR_ID,
          targetUserId: userId,
          type: ModerationMuteType.TEMPORARY,
          reason,
          expiresAt: expiresAt.toISOString(),
        }),
      );
    });
  }

  /**
   * System-initiated kick with no actor authorisation — invoked when a user
   * crosses the auto-kick threshold. Idempotent: a no-op when the user is no
   * longer an active member. Audited as `CHAT_AUTO_KICKED` with a null moderator.
   */
  async autoKick(roomId: string, userId: string, reason: string): Promise<void> {
    await this.locks.withLock(moderationLockKey(roomId), async () => {
      const member = await this.rooms.getMember(roomId, userId);
      if (!member?.isActive) return;
      await this.removeFromRoom(roomId, userId, SYSTEM_MODERATOR_ID);
      await this.repo.appendAction({
        roomId,
        moderatorId: null,
        targetUserId: userId,
        action: ModerationActionType.CHAT_AUTO_KICKED,
        reason,
        metadata: { system: true },
      });
    });
    await this.bus.publish(
      new MemberKickedEvent({
        roomId,
        moderatorId: SYSTEM_MODERATOR_ID,
        targetUserId: userId,
        reason,
      }),
    );
    await this.notifyUser(userId, 'audio_room.kicked', { roomId, reason });
  }

  // ======================= Reads =======================

  /**
   * The room's Kick List — currently-kicked users, newest first, hydrated with the
   * target's avatar/username and the moderator's username. Moderator-only: the
   * caller must hold MODERATE_USERS (owner / admin / premium admin) in the room.
   */
  async listKicks(
    actor: RoomActor,
    roomId: string,
    q: ListModerationDto,
  ): Promise<Paginated<RoomKickView>> {
    await this.permissions.assertCanModerate(roomId, actor);
    const [rows, total] = await this.repo.listActiveKicks(roomId, q.skip, q.limit);
    const summaries = await this.repo.resolveUserSummaries(
      rows.flatMap((k) => [k.userId, k.moderatorId]),
    );
    const views = rows.map((k) => this.toKickView(k, summaries));
    return buildPaginated(views, total, q.page, q.limit);
  }

  async listBans(roomId: string, q: ListModerationDto): Promise<Paginated<RoomBan>> {
    const [rows, total] = await this.repo.listActiveBans(roomId, q.skip, q.limit);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async listMutes(roomId: string, q: ListModerationDto): Promise<Paginated<RoomMute>> {
    const [rows, total] = await this.repo.listActiveMutes(roomId, q.skip, q.limit);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async listActions(roomId: string, q: ListModerationDto): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listActions(roomId, q.skip, q.limit, q.targetUserId);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async listNotes(roomId: string, q: ListModerationDto): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listNotes(roomId, q.skip, q.limit, q.targetUserId);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async listReports(roomId: string, q: ListModerationDto): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listReports(roomId, q.skip, q.limit);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async listAppeals(roomId: string, q: ListModerationDto): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listAppeals(roomId, q.skip, q.limit);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  // ======================= Public contract (IModerationService) =======================

  async isKicked(roomId: string, userId: string): Promise<boolean> {
    if (await this.repo.isKickedCached(roomId, userId)) return true;
    return (await this.repo.findActiveKick(roomId, userId)) !== null;
  }

  async assertNotKicked(roomId: string, userId: string): Promise<void> {
    if (await this.isKicked(roomId, userId)) {
      throw new BusinessException(
        ERROR_CODES.ROOM_KICKED,
        'You were kicked from this room and cannot rejoin until a moderator restores you.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  async isBanned(roomId: string, userId: string): Promise<boolean> {
    if (await this.repo.isBannedCached(roomId, userId)) return true;
    return (await this.repo.findActiveBan(roomId, userId)) !== null;
  }

  async isMuted(roomId: string, userId: string): Promise<boolean> {
    if (await this.repo.isMutedCached(roomId, userId)) return true;
    return (await this.repo.findActiveMute(roomId, userId)) !== null;
  }

  async assertNotBanned(roomId: string, userId: string): Promise<void> {
    if (await this.isBanned(roomId, userId)) {
      throw new BusinessException(
        ERROR_CODES.ROOM_BANNED,
        'You are banned from this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  // ======================= Internals =======================

  private toKickView(kick: RoomKick, summaries: Map<string, ModeratedUserSummary>): RoomKickView {
    const target = summaries.get(kick.userId);
    const moderator = summaries.get(kick.moderatorId);
    return {
      id: kick.id,
      roomId: kick.roomId,
      targetUserId: kick.userId,
      targetUsername: target?.username ?? null,
      targetAvatarKey: target?.avatarKey ?? null,
      moderatorId: kick.moderatorId,
      moderatorUsername: moderator?.username ?? null,
      reason: kick.reason,
      createdAt: kick.createdAt,
    };
  }

  private resolveExpiry(isTemporary: boolean, durationMinutes?: number): Date | null {
    if (!isTemporary) return null;
    if (!durationMinutes || durationMinutes <= 0) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'A temporary action requires durationMinutes.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return new Date(Date.now() + durationMinutes * 60_000);
  }

  /** Assert the actor can moderate this room, isn't targeting themselves, and outranks the target. */
  private async assertModerationPrereqs(
    roomId: string,
    actor: RoomActor,
    targetUserId: string,
  ): Promise<void> {
    if (targetUserId === actor.id) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_MODERATE_SELF,
        'You cannot moderate yourself.',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.permissions.assertCanModerate(roomId, actor);
    await this.permissions.assertOutranks(roomId, actor, targetUserId);
    const room = await this.requireRoom(roomId);
    await this.scopeService.assertModeratorInScope(actor.id, room.ownerId);
  }

  /**
   * Resolve the room row or 404 — the Audio Room counterpart of Video Room's
   * `requireRoom()` and Live Streaming's `getStream()`.
   *
   * Every moderation call site must go through this rather than reading
   * `findRoomRow` directly: a `null` room would otherwise skip the scope
   * check entirely rather than calling it with the room's real `ownerId`.
   */
  private async requireRoom(roomId: string): Promise<AudioRoom> {
    const room = await this.rooms.findRoomRow(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return room;
  }

  /** Remove a user from the room now: deactivate, drop presence, tear down voice. */
  private async removeFromRoom(roomId: string, userId: string, actorId: string): Promise<void> {
    await this.rooms.deactivateMember(roomId, userId, actorId);
    await this.presence.leaveRoom(roomId, userId);
    await this.rooms.removePresence(roomId, userId);
    await this.voice.forceLeave(roomId, userId);
    const count = await this.presence.roomMemberCount(roomId);
    await this.rooms.bumpStatsOnLeave(roomId, count);
    // Vacate their seat + sync voice role via the AR-1/AR-2 leave reactions.
    await this.bus.publish(new RoomLeftEvent({ roomId, userId, participantCount: count }));
  }

  private async liftBanInternal(
    ban: RoomBan,
    actorId: string,
    status: 'LIFTED' | 'EXPIRED',
    reason: 'lifted' | 'expired' | 'appeal_approved',
  ): Promise<void> {
    await this.repo.liftBan(ban.id, actorId, status);
    await this.repo.removeBanCache(ban.roomId, ban.userId);
    await this.repo.appendAction({
      roomId: ban.roomId,
      moderatorId: actorId,
      targetUserId: ban.userId,
      action: ModerationActionType.UNBAN,
      metadata: { banId: ban.id, reason },
    });
    await this.bus.publish(
      new MemberUnbannedEvent({
        roomId: ban.roomId,
        moderatorId: actorId,
        targetUserId: ban.userId,
        reason,
      }),
    );
  }

  private async liftMuteInternal(
    mute: RoomMute,
    actorId: string,
    status: 'LIFTED' | 'EXPIRED',
    reason: 'lifted' | 'expired' | 'appeal_approved',
  ): Promise<void> {
    await this.repo.liftMute(mute.id, actorId, status);
    await this.repo.removeMuteCache(mute.roomId, mute.userId);
    await this.voice.forceMute(mute.roomId, mute.userId, false);
    await this.repo.appendAction({
      roomId: mute.roomId,
      moderatorId: actorId,
      targetUserId: mute.userId,
      action: ModerationActionType.UNMUTE,
      metadata: { muteId: mute.id, reason },
    });
    await this.bus.publish(
      new MemberUnmutedEvent({
        roomId: mute.roomId,
        moderatorId: actorId,
        targetUserId: mute.userId,
        reason,
      }),
    );
  }

  /** Owner + elevated members to notify of a report/appeal (excluding the actor). */
  private async moderatorRecipients(roomId: string, excludeUserId: string): Promise<string[]> {
    const ids = new Set(await this.seats.listElevatedMemberIds(roomId));
    const owner = await this.rooms.getOwnerId(roomId);
    if (owner) ids.add(owner);
    ids.delete(excludeUserId);
    return [...ids];
  }

  private async notifyUser(
    userId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.queue.enqueue(QUEUE_NAMES.NOTIFICATIONS, type, { userId, ...data });
  }
}
