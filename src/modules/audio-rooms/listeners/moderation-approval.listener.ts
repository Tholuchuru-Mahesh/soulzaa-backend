import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModerationBanType, type PlatformRole } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import {
  MODERATION_APPROVAL_EVENTS,
  type ModerationActionApprovedEvent,
} from 'src/modules/moderation-approval/events/moderation-approval.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { ModerationService } from '../services/moderation.service';

/**
 * Executes a moderator's proposed BAN once an Official approves it. The
 * moderator's roles are re-resolved fresh at execution time (not carried
 * from the original request) since approval can land long after the
 * proposing request's token was issued — `ModerationService.ban` still
 * enforces the same in-room/outrank checks it always does, this only
 * supplies who is acting.
 */
@Injectable()
export class AudioRoomModerationApprovalListener implements OnModuleInit {
  private readonly logger = new Logger(AudioRoomModerationApprovalListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly moderation: ModerationService,
    private readonly roles: RoleResolver,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<ModerationActionApprovedEvent>(
      MODERATION_APPROVAL_EVENTS.APPROVED,
      (e) => this.handleApproved(e),
    );
  }

  private async handleApproved(event: ModerationActionApprovedEvent): Promise<void> {
    const { roomType, roomId, targetUserId, proposedBy, reason } = event.payload;
    if (roomType !== 'AUDIO_ROOM' || !roomId) return;

    try {
      const roleNames = await this.roles.getRoleNames(proposedBy);
      const actor: RoomActor = { id: proposedBy, roles: roleNames as PlatformRole[] };
      await this.moderation.ban(actor, roomId, targetUserId, {
        type: ModerationBanType.PERMANENT,
        reason: reason ?? undefined,
      });
    } catch (err) {
      this.logger.error(
        `Failed to execute approved ban for approval ${event.payload.approvalId}: ${(err as Error).message}`,
      );
    }
  }
}
