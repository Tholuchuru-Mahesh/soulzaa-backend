import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InvitationType, NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES, type PushCategory } from 'src/modules/device/interfaces/push.constants';
import {
  SOCIAL_EVENTS,
  type FollowedEvent,
  type FriendRequestAcceptedEvent,
  type FriendRequestSentEvent,
  type InvitationSentEvent,
} from 'src/modules/social/events/social.events';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { NotificationService } from '../services/notification.service';

/** Maps an invitation resource type to its notification type. */
const INVITE_NOTIFICATION: Record<InvitationType, NotificationType> = {
  [InvitationType.AUDIO_ROOM]: NotificationType.ROOM_INVITE,
  [InvitationType.GAME]: NotificationType.GAME_INVITE,
  [InvitationType.FAMILY]: NotificationType.FAMILY_INVITE,
  [InvitationType.PK_BATTLE]: NotificationType.PK_INVITE,
  [InvitationType.EVENT]: NotificationType.EVENT_INVITE,
};

/** What an invitation is *called*, in the one line a lock screen gives us. */
const INVITE_BODY: Record<InvitationType, string> = {
  [InvitationType.AUDIO_ROOM]: 'Invited you to a room',
  [InvitationType.GAME]: 'Invited you to a game',
  [InvitationType.FAMILY]: 'Invited you to their family',
  [InvitationType.PK_BATTLE]: 'Challenged you to a PK battle',
  [InvitationType.EVENT]: 'Invited you to an event',
};

/**
 * The `data.type` the client routes on.
 *
 * Deliberately *specific* rather than a generic `"invitation"` with a discriminator
 * beside it: the client's deep-link table maps a type straight to a destination, and
 * a push that says only "an invitation happened" forces every consumer to re-derive
 * where it goes. The type a client reads is the type it can act on.
 */
const INVITE_PUSH_TYPE: Record<InvitationType, string> = {
  [InvitationType.AUDIO_ROOM]: 'room_invitation',
  [InvitationType.GAME]: 'game_invitation',
  [InvitationType.FAMILY]: 'family_invitation',
  [InvitationType.PK_BATTLE]: 'pk_invitation',
  [InvitationType.EVENT]: 'event',
};

/**
 * Bridges social domain events into durable in-app notifications and push. Keeps
 * the write path inside the notification module (which owns the tables); the
 * social module only produces events. Denormalises the actor card into `data` so
 * the notification centre renders without extra lookups.
 *
 * None of these bodies carry private content — "started following you" is not a
 * secret — so none of them supply a `redactedBody`. Preview-off users see the same
 * text, which is the honest outcome: there is nothing here to hide.
 */
@Injectable()
export class SocialNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<FollowedEvent>(SOCIAL_EVENTS.FOLLOWED, (e) => this.onFollowed(e));
    this.bus.subscribe<FriendRequestSentEvent>(SOCIAL_EVENTS.FRIEND_REQUEST_SENT, (e) =>
      this.onFriendRequest(e),
    );
    this.bus.subscribe<FriendRequestAcceptedEvent>(SOCIAL_EVENTS.FRIEND_REQUEST_ACCEPTED, (e) =>
      this.onFriendAccepted(e),
    );
    this.bus.subscribe<InvitationSentEvent>(SOCIAL_EVENTS.INVITATION_SENT, (e) =>
      this.onInvitation(e),
    );
  }

  private async onFollowed(e: FollowedEvent): Promise<void> {
    const { followerId, followingId } = e.payload;
    const actor = await this.actor(followerId);

    await this.notifications.create({
      userId: followingId,
      type: NotificationType.NEW_FOLLOWER,
      actorId: followerId,
      data: actor.data,
    });
    await this.push(followingId, PUSH_CATEGORIES.FOLLOW, actor.name, 'Started following you', {
      type: 'follower',
      userId: followerId,
    });
  }

  private async onFriendRequest(e: FriendRequestSentEvent): Promise<void> {
    const { addresseeId, requesterId, requestId } = e.payload;
    const actor = await this.actor(requesterId);

    await this.notifications.create({
      userId: addresseeId,
      type: NotificationType.FRIEND_REQUEST,
      actorId: requesterId,
      entityType: 'friend_request',
      entityId: requestId,
      data: actor.data,
    });
    await this.push(addresseeId, PUSH_CATEGORIES.FRIEND, actor.name, 'Sent you a friend request', {
      type: 'friend_request',
      requestId,
      userId: requesterId,
    });
  }

  private async onFriendAccepted(e: FriendRequestAcceptedEvent): Promise<void> {
    const { requesterId, addresseeId, friendshipId } = e.payload;
    const actor = await this.actor(addresseeId);

    await this.notifications.create({
      userId: requesterId,
      type: NotificationType.FRIEND_ACCEPTED,
      actorId: addresseeId,
      entityType: 'friendship',
      entityId: friendshipId,
      data: actor.data,
    });
    await this.push(
      requesterId,
      PUSH_CATEGORIES.FRIEND,
      actor.name,
      'Accepted your friend request',
      { type: 'friend_accepted', friendshipId, userId: addresseeId },
    );
  }

  private async onInvitation(e: InvitationSentEvent): Promise<void> {
    const { inviteeId, inviterId, invitationId, type, targetId } = e.payload;
    const actor = await this.actor(inviterId);

    await this.notifications.create({
      userId: inviteeId,
      type: INVITE_NOTIFICATION[type],
      actorId: inviterId,
      entityType: 'invitation',
      entityId: invitationId,
      data: { ...(actor.data ?? {}), targetId },
    });
    await this.push(inviteeId, PUSH_CATEGORIES.INVITE, actor.name, INVITE_BODY[type], {
      type: INVITE_PUSH_TYPE[type],
      invitationId,
      invitationType: type,
      // Not every invitation names a target (a family invite has none). FCM data is
      // string-valued, so an absent target is an absent key — never the string "null",
      // which a client would dutifully try to route to.
      ...(targetId ? { targetId } : {}),
      userId: inviterId,
    });
  }

  // ---- Helpers ----

  /** The actor's display name, plus the denormalised card the centre renders from. */
  private async actor(
    actorId: string,
  ): Promise<{ name: string; data: Record<string, unknown> | null }> {
    const [card] = await this.profile.getCards([actorId]);
    if (!card) return { name: 'Someone', data: null };
    return {
      name: card.fullName ?? card.username,
      data: { username: card.username, fullName: card.fullName, avatarUrl: card.avatarUrl },
    };
  }

  private push(
    userId: string,
    category: PushCategory,
    title: string,
    body: string,
    data: Record<string, string>,
  ): Promise<boolean> {
    return this.notifications.notify(userId, {
      category,
      title,
      body,
      threadId: `social_${userId}`,
      badge: 'unread',
      data,
    });
  }
}
