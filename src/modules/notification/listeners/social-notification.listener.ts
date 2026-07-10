import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InvitationType, NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
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

/**
 * Bridges social domain events into durable in-app notifications. Keeps the
 * write path inside the notification module (which owns the tables); the social
 * module only produces events. Denormalises the actor card into `data` so the
 * notification center renders without extra lookups.
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

  private async actorData(actorId: string): Promise<Record<string, unknown> | null> {
    const [card] = await this.profile.getCards([actorId]);
    return card
      ? { username: card.username, fullName: card.fullName, avatarUrl: card.avatarUrl }
      : null;
  }

  private async onFollowed(e: FollowedEvent): Promise<void> {
    await this.notifications.create({
      userId: e.payload.followingId,
      type: NotificationType.NEW_FOLLOWER,
      actorId: e.payload.followerId,
      data: await this.actorData(e.payload.followerId),
    });
  }

  private async onFriendRequest(e: FriendRequestSentEvent): Promise<void> {
    await this.notifications.create({
      userId: e.payload.addresseeId,
      type: NotificationType.FRIEND_REQUEST,
      actorId: e.payload.requesterId,
      entityType: 'friend_request',
      entityId: e.payload.requestId,
      data: await this.actorData(e.payload.requesterId),
    });
  }

  private async onFriendAccepted(e: FriendRequestAcceptedEvent): Promise<void> {
    await this.notifications.create({
      userId: e.payload.requesterId,
      type: NotificationType.FRIEND_ACCEPTED,
      actorId: e.payload.addresseeId,
      entityType: 'friendship',
      entityId: e.payload.friendshipId,
      data: await this.actorData(e.payload.addresseeId),
    });
  }

  private async onInvitation(e: InvitationSentEvent): Promise<void> {
    const actor = await this.actorData(e.payload.inviterId);
    await this.notifications.create({
      userId: e.payload.inviteeId,
      type: INVITE_NOTIFICATION[e.payload.type],
      actorId: e.payload.inviterId,
      entityType: 'invitation',
      entityId: e.payload.invitationId,
      data: { ...(actor ?? {}), targetId: e.payload.targetId },
    });
  }
}
