import { ModerationApprovalRoomType } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

export const MODERATION_APPROVAL_EVENTS = {
  APPROVED: 'moderation.action_approval.approved',
  REJECTED: 'moderation.action_approval.rejected',
} as const;

interface ModerationApprovalEventPayload {
  approvalId: string;
  roomType: ModerationApprovalRoomType;
  roomId: string | null;
  liveStreamId: string | null;
  reportId: string;
  proposedBy: string;
  targetUserId: string;
  action: string;
  reason: string | null;
  decidedBy: string;
}

/**
 * An Official approved a moderator's proposed BAN. The room type named by
 * `roomType` owns exactly one listener that filters for its own type and
 * executes the ban via its own moderation service — this event is the only
 * coupling between the moderation-approval module and the room modules.
 */
export class ModerationActionApprovedEvent extends DomainEvent<ModerationApprovalEventPayload> {
  readonly name = MODERATION_APPROVAL_EVENTS.APPROVED;
}

/** An Official rejected a moderator's proposed BAN — no action executes. */
export class ModerationActionRejectedEvent extends DomainEvent<ModerationApprovalEventPayload> {
  readonly name = MODERATION_APPROVAL_EVENTS.REJECTED;
}
