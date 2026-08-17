import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModerationActionApproval, ModerationApprovalRoomType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import {
  ModerationActionApprovedEvent,
  ModerationActionRejectedEvent,
} from '../events/moderation-approval.events';

export interface ProposeApprovalInput {
  roomType: ModerationApprovalRoomType;
  roomId?: string;
  liveStreamId?: string;
  reportId: string;
  proposedBy: string;
  targetUserId: string;
  reason?: string;
  regionId?: string | null;
}

export type ApprovalDecision = 'APPROVED' | 'REJECTED';

/**
 * A moderator's recommended BAN sits PENDING here until an Official decides
 * it. Routing reuses `WorkforceScopeService.resolveEscalationRecipients`
 * with 'HIGH' severity — the same Official-covering-the-region audience an
 * escalated critical violation already reaches, since a proposed ban is the
 * same kind of "this needs a second set of eyes" event. Execution never
 * happens here: `decide()` only flips state and publishes an event, and each
 * room module's own listener (subscribed to that event, filtering by its own
 * `roomType`) executes the ban with its own service. See the schema doc
 * comment on `ModerationActionApproval` for why.
 */
@Injectable()
export class ModerationApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: WorkforceScopeService,
    @Optional() @Inject(NOTIFICATION_SERVICE) private readonly notifications?: INotificationService,
    @Optional() @Inject(EVENT_BUS) private readonly bus?: IEventBus,
  ) {}

  async propose(input: ProposeApprovalInput): Promise<ModerationActionApproval> {
    const approval = await this.prisma.moderationActionApproval.create({
      data: {
        roomType: input.roomType,
        roomId: input.roomId ?? null,
        liveStreamId: input.liveStreamId ?? null,
        reportId: input.reportId,
        proposedBy: input.proposedBy,
        targetUserId: input.targetUserId,
        reason: input.reason ?? null,
        status: 'PENDING',
      },
    });

    if (this.notifications) {
      const recipients = await this.scopeService.resolveEscalationRecipients(
        'HIGH',
        input.regionId ?? null,
      );
      await Promise.all(
        recipients.map((userId) =>
          this.notifications!.create({
            userId,
            type: 'MODERATION_CASE_ESCALATED',
            actorId: input.proposedBy,
            entityType: 'moderation_action_approval',
            entityId: approval.id,
            data: {
              targetUserId: input.targetUserId,
              reason: input.reason ?? null,
              action: approval.action,
              kind: 'PENDING_BAN_APPROVAL',
            },
          }),
        ),
      );
    }

    return approval;
  }

  async getById(id: string): Promise<ModerationActionApproval> {
    const approval = await this.prisma.moderationActionApproval.findUnique({ where: { id } });
    if (!approval) throw new NotFoundException('Approval request not found');
    return approval;
  }

  async listPending(roomType?: ModerationApprovalRoomType): Promise<ModerationActionApproval[]> {
    return this.prisma.moderationActionApproval.findMany({
      where: { status: 'PENDING', ...(roomType ? { roomType } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Resolves the region snapshot for the approval's target resource so
   * `decide()` can enforce `assertModeratorInScope`. A `null` return is only
   * legitimate when `roomId`/`liveStreamId` is itself absent on the approval
   * row (no region snapshot exists for this resource type) — that's the
   * genuine "unscoped, permit" case `assertModeratorInScope` treats as a
   * safety valve. When `roomId`/`liveStreamId` IS present (proving the
   * resource existed at `propose()` time) but the lookup now returns
   * nothing, that's a vanished row, not an unscoped one — throw rather than
   * silently falling through to the same permit path.
   */
  private async resolveRegion(
    roomType: ModerationApprovalRoomType,
    roomId: string | null,
    liveStreamId: string | null,
  ): Promise<string | null> {
    if (roomType === 'AUDIO_ROOM' && roomId) {
      const room = await this.prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { region: true },
      });
      if (!room) throw new NotFoundException('Audio room not found');
      return room.region ?? null;
    }
    if (roomType === 'VIDEO_ROOM' && roomId) {
      const room = await this.prisma.videoRoom.findUnique({
        where: { id: roomId },
        select: { region: true },
      });
      if (!room) throw new NotFoundException('Video room not found');
      return room.region ?? null;
    }
    if (roomType === 'LIVE_STREAM' && liveStreamId) {
      const stream = await this.prisma.liveStream.findUnique({
        where: { id: liveStreamId },
        select: { regionId: true },
      });
      if (!stream) throw new NotFoundException('Live stream not found');
      return stream.regionId ?? null;
    }
    return null;
  }

  async decide(
    approvalId: string,
    deciderId: string,
    decision: ApprovalDecision,
    note?: string,
  ): Promise<ModerationActionApproval> {
    const approval = await this.getById(approvalId);
    if (approval.status !== 'PENDING') {
      throw new ConflictException('This approval request has already been decided');
    }

    const region = await this.resolveRegion(
      approval.roomType,
      approval.roomId,
      approval.liveStreamId,
    );
    await this.scopeService.assertModeratorInScope(deciderId, region);

    const updated = await this.prisma.moderationActionApproval.update({
      where: { id: approvalId },
      data: {
        status: decision,
        decidedBy: deciderId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    });

    const payload = {
      approvalId: updated.id,
      roomType: updated.roomType,
      roomId: updated.roomId,
      liveStreamId: updated.liveStreamId,
      reportId: updated.reportId,
      proposedBy: updated.proposedBy,
      targetUserId: updated.targetUserId,
      action: updated.action,
      reason: updated.reason,
      decidedBy: deciderId,
    };

    if (this.bus) {
      await this.bus.publish(
        decision === 'APPROVED'
          ? new ModerationActionApprovedEvent(payload)
          : new ModerationActionRejectedEvent(payload),
      );
    }

    if (this.notifications) {
      await this.notifications.create({
        userId: updated.proposedBy,
        type: 'SYSTEM',
        actorId: deciderId,
        entityType: 'moderation_action_approval',
        entityId: updated.id,
        data: {
          decision,
          note: note ?? null,
          targetUserId: updated.targetUserId,
          action: updated.action,
        },
      });
    }

    return updated;
  }
}
