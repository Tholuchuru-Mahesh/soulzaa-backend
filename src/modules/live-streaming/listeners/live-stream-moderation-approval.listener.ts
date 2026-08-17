import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  MODERATION_APPROVAL_EVENTS,
  type ModerationActionApprovedEvent,
} from 'src/modules/moderation-approval/events/moderation-approval.events';
import { LiveStreamService } from '../services/live-stream.service';

/**
 * Executes a moderator's proposed BAN once an Official approves it. Mirrors
 * the Audio Room / Video Room approval listeners; `LiveStreamService.moderateUser`
 * takes a bare `moderatorId` (no `RoomActor`/roles needed here), so unlike
 * its siblings this listener does no role re-resolution.
 */
@Injectable()
export class LiveStreamModerationApprovalListener implements OnModuleInit {
  private readonly logger = new Logger(LiveStreamModerationApprovalListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly liveStream: LiveStreamService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<ModerationActionApprovedEvent>(MODERATION_APPROVAL_EVENTS.APPROVED, (e) =>
      this.handleApproved(e),
    );
  }

  private async handleApproved(event: ModerationActionApprovedEvent): Promise<void> {
    const { roomType, liveStreamId, targetUserId, proposedBy, reason } = event.payload;
    if (roomType !== 'LIVE_STREAM' || !liveStreamId) return;

    try {
      await this.liveStream.moderateUser({
        streamId: liveStreamId,
        moderatorId: proposedBy,
        targetUserId,
        action: 'BAN',
        reason: reason ?? undefined,
      });
    } catch (err) {
      this.logger.error(
        `Failed to execute approved ban for approval ${event.payload.approvalId}: ${(err as Error).message}`,
      );
    }
  }
}
