import { InvitationType } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Social-graph lifecycle events on the EVENT_BUS. The social socket listener
 * fans these out to the recipient's per-user room on `/notifications`; the
 * notification module bridges the friend/follow/invite events into stored
 * notifications + push. Dot-namespaced names, extended per slice.
 */
export const SOCIAL_EVENTS = {
  FOLLOWED: 'social.followed',
  UNFOLLOWED: 'social.unfollowed',
  FRIEND_REQUEST_SENT: 'social.friend.request_sent',
  FRIEND_REQUEST_ACCEPTED: 'social.friend.accepted',
  FRIEND_REQUEST_REJECTED: 'social.friend.rejected',
  FRIEND_REMOVED: 'social.friend.removed',
  INVITATION_SENT: 'social.invitation.sent',
  INVITATION_ACCEPTED: 'social.invitation.accepted',
  INVITATION_DECLINED: 'social.invitation.declined',
} as const;

export class FollowedEvent extends DomainEvent<{
  followerId: string;
  followingId: string;
  followersCount: number;
}> {
  readonly name = SOCIAL_EVENTS.FOLLOWED;
}

export class UnfollowedEvent extends DomainEvent<{
  followerId: string;
  followingId: string;
  followersCount: number;
}> {
  readonly name = SOCIAL_EVENTS.UNFOLLOWED;
}

export class FriendRequestSentEvent extends DomainEvent<{
  requestId: string;
  requesterId: string;
  addresseeId: string;
  message: string | null;
  expiresAt: Date;
}> {
  readonly name = SOCIAL_EVENTS.FRIEND_REQUEST_SENT;
}

export class FriendRequestAcceptedEvent extends DomainEvent<{
  requestId: string;
  friendshipId: string;
  requesterId: string;
  addresseeId: string;
}> {
  readonly name = SOCIAL_EVENTS.FRIEND_REQUEST_ACCEPTED;
}

export class FriendRequestRejectedEvent extends DomainEvent<{
  requestId: string;
  requesterId: string;
  addresseeId: string;
}> {
  readonly name = SOCIAL_EVENTS.FRIEND_REQUEST_REJECTED;
}

export class FriendRemovedEvent extends DomainEvent<{
  removerId: string;
  removedId: string;
}> {
  readonly name = SOCIAL_EVENTS.FRIEND_REMOVED;
}

export class InvitationSentEvent extends DomainEvent<{
  invitationId: string;
  type: InvitationType;
  inviterId: string;
  inviteeId: string;
  targetId: string | null;
  payload: unknown;
  expiresAt: Date;
}> {
  readonly name = SOCIAL_EVENTS.INVITATION_SENT;
}

export class InvitationAcceptedEvent extends DomainEvent<{
  invitationId: string;
  type: InvitationType;
  inviterId: string;
  inviteeId: string;
  targetId: string | null;
}> {
  readonly name = SOCIAL_EVENTS.INVITATION_ACCEPTED;
}

export class InvitationDeclinedEvent extends DomainEvent<{
  invitationId: string;
  inviterId: string;
  inviteeId: string;
}> {
  readonly name = SOCIAL_EVENTS.INVITATION_DECLINED;
}
