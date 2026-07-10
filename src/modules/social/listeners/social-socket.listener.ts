import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { USER_ROOM_PREFIX } from 'src/common/constants/socket.constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { SOCIAL_NAMESPACE, SOCIAL_SOCKET_EVENTS } from '../constants/social.constants';
import {
  SOCIAL_EVENTS,
  type FollowedEvent,
  type FriendRemovedEvent,
  type FriendRequestAcceptedEvent,
  type FriendRequestRejectedEvent,
  type FriendRequestSentEvent,
  type InvitationAcceptedEvent,
  type InvitationDeclinedEvent,
  type InvitationSentEvent,
  type UnfollowedEvent,
} from '../events/social.events';
import { CardResolver } from '../services/card.resolver';

/**
 * Realtime social fan-out. Subscribes to social domain events and emits the
 * matching client event to the recipient's per-user room on `/notifications`
 * (every one of a user's sockets joins `user:<id>` on connect). Extended per
 * slice with friend/invitation/presence events.
 */
@Injectable()
export class SocialSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
    private readonly cards: CardResolver,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<FollowedEvent>(SOCIAL_EVENTS.FOLLOWED, (e) => this.onFollowed(e));
    this.bus.subscribe<UnfollowedEvent>(SOCIAL_EVENTS.UNFOLLOWED, (e) => this.onUnfollowed(e));
    this.bus.subscribe<FriendRequestSentEvent>(SOCIAL_EVENTS.FRIEND_REQUEST_SENT, (e) =>
      this.onFriendRequest(e),
    );
    this.bus.subscribe<FriendRequestAcceptedEvent>(SOCIAL_EVENTS.FRIEND_REQUEST_ACCEPTED, (e) =>
      this.onFriendAccepted(e),
    );
    this.bus.subscribe<FriendRequestRejectedEvent>(SOCIAL_EVENTS.FRIEND_REQUEST_REJECTED, (e) =>
      this.onFriendRejected(e),
    );
    this.bus.subscribe<FriendRemovedEvent>(SOCIAL_EVENTS.FRIEND_REMOVED, (e) =>
      this.onFriendRemoved(e),
    );
    this.bus.subscribe<InvitationSentEvent>(SOCIAL_EVENTS.INVITATION_SENT, (e) =>
      this.onInvitationSent(e),
    );
    this.bus.subscribe<InvitationAcceptedEvent>(SOCIAL_EVENTS.INVITATION_ACCEPTED, (e) =>
      this.onInvitationAccepted(e),
    );
    this.bus.subscribe<InvitationDeclinedEvent>(SOCIAL_EVENTS.INVITATION_DECLINED, (e) =>
      this.onInvitationDeclined(e),
    );
  }

  private async onInvitationSent(e: InvitationSentEvent): Promise<void> {
    const { invitationId, type, inviterId, inviteeId, targetId, payload, expiresAt } = e.payload;
    const inviter = await this.cards.resolveOne(inviterId);
    this.emitToUser(inviteeId, SOCIAL_SOCKET_EVENTS.INVITATION_SENT, {
      invitationId,
      type,
      inviter,
      targetId,
      payload,
      expiresAt,
    });
  }

  private async onInvitationAccepted(e: InvitationAcceptedEvent): Promise<void> {
    const { invitationId, type, inviterId, inviteeId, targetId } = e.payload;
    const invitee = await this.cards.resolveOne(inviteeId);
    this.emitToUser(inviterId, SOCIAL_SOCKET_EVENTS.INVITATION_ACCEPTED, {
      invitationId,
      invitee,
      type,
      targetId,
    });
  }

  private async onInvitationDeclined(e: InvitationDeclinedEvent): Promise<void> {
    const { invitationId, inviterId, inviteeId } = e.payload;
    const invitee = await this.cards.resolveOne(inviteeId);
    this.emitToUser(inviterId, SOCIAL_SOCKET_EVENTS.INVITATION_DECLINED, { invitationId, invitee });
  }

  private async onFriendRequest(e: FriendRequestSentEvent): Promise<void> {
    const { requestId, requesterId, addresseeId, message, expiresAt } = e.payload;
    const requester = await this.cards.resolveOne(requesterId);
    this.emitToUser(addresseeId, SOCIAL_SOCKET_EVENTS.FRIEND_REQUEST, {
      requestId,
      requester,
      message,
      expiresAt,
    });
  }

  private async onFriendAccepted(e: FriendRequestAcceptedEvent): Promise<void> {
    const { requestId, friendshipId, requesterId, addresseeId } = e.payload;
    const user = await this.cards.resolveOne(addresseeId);
    this.emitToUser(requesterId, SOCIAL_SOCKET_EVENTS.FRIEND_ACCEPTED, {
      requestId,
      friendshipId,
      user,
    });
  }

  private onFriendRejected(e: FriendRequestRejectedEvent): void {
    const { requestId, requesterId } = e.payload;
    this.emitToUser(requesterId, SOCIAL_SOCKET_EVENTS.FRIEND_DECLINED, { requestId });
  }

  private onFriendRemoved(e: FriendRemovedEvent): void {
    const { removerId, removedId } = e.payload;
    this.emitToUser(removedId, SOCIAL_SOCKET_EVENTS.FRIEND_REMOVED, { userId: removerId });
  }

  private async onFollowed(e: FollowedEvent): Promise<void> {
    const { followerId, followingId, followersCount } = e.payload;
    const follower = await this.cards.resolveOne(followerId);
    this.emitToUser(followingId, SOCIAL_SOCKET_EVENTS.FOLLOW, { follower, followersCount });
  }

  private onUnfollowed(e: UnfollowedEvent): void {
    const { followerId, followingId, followersCount } = e.payload;
    this.emitToUser(followingId, SOCIAL_SOCKET_EVENTS.UNFOLLOW, {
      userId: followerId,
      followersCount,
    });
  }

  /** Emit to every socket a user has on the notifications namespace. */
  private emitToUser(userId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(
      SOCIAL_NAMESPACE,
      `${USER_ROOM_PREFIX}${userId}`,
      event,
      payload,
    );
  }
}
