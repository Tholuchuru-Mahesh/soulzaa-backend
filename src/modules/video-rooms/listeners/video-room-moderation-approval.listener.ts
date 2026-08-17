import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { VideoRoomBlockType, type PlatformRole } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import {
  MODERATION_APPROVAL_EVENTS,
  type ModerationActionApprovedEvent,
} from 'src/modules/moderation-approval/events/moderation-approval.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomModerationService } from '../services/video-room-moderation.service';

/**
 * Executes a moderator's proposed BAN (blacklist) once an Official approves
 * it. Mirrors the Audio Room `AudioRoomModerationApprovalListener` — see its
 * doc comment for why roles are re-resolved fresh at execution time.
 */
@Injectable()
export class VideoRoomModerationApprovalListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomModerationApprovalListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly moderation: VideoRoomModerationService,
    private readonly roles: RoleResolver,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<ModerationActionApprovedEvent>(MODERATION_APPROVAL_EVENTS.APPROVED, (e) =>
      this.handleApproved(e),
    );
  }

  private async handleApproved(event: ModerationActionApprovedEvent): Promise<void> {
    const { roomType, roomId, targetUserId, proposedBy, reason } = event.payload;
    if (roomType !== 'VIDEO_ROOM' || !roomId) return;

    try {
      const roleNames = await this.roles.getRoleNames(proposedBy);
      const actor: RoomActor = { id: proposedBy, roles: roleNames as PlatformRole[] };
      await this.moderation.blacklist(
        actor,
        roomId,
        targetUserId,
        reason ?? undefined,
        VideoRoomBlockType.PERMANENT,
      );
    } catch (err) {
      this.logger.error(
        `Failed to execute approved ban for approval ${event.payload.approvalId}: ${(err as Error).message}`,
      );
    }
  }
}
