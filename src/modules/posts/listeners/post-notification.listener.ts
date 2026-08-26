import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import { PROFILE_SERVICE, type IProfileService } from 'src/modules/users/interfaces/profile.interface';
import { POST_EVENTS, type PostCommentedEvent, type PostLikedEvent } from '../events/post.events';

@Injectable()
export class PostNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: INotificationService,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PostLikedEvent>(POST_EVENTS.LIKED, (e) => this.onLiked(e));
    this.bus.subscribe<PostCommentedEvent>(POST_EVENTS.COMMENTED, (e) => this.onCommented(e));
  }

  private async onLiked(e: PostLikedEvent): Promise<void> {
    const { postId, userId } = e.payload;
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.authorId === userId) return;

    const actor = await this.actorCard(userId);
    await this.notifications.create({
      userId: post.authorId,
      type: NotificationType.POST_LIKED,
      actorId: userId,
      entityType: 'post',
      entityId: postId,
      data: actor.data,
    });
    // Reuses the FOLLOW/social push category — a dedicated POST category
    // would need a new Android channel + client registration, out of scope here.
    await this.notifications.notify(post.authorId, {
      category: PUSH_CATEGORIES.FOLLOW,
      title: actor.name,
      body: 'Liked your post',
      threadId: `post_${postId}`,
      badge: 'unread',
      data: { type: 'post_liked', postId, userId },
    });
  }

  private async onCommented(e: PostCommentedEvent): Promise<void> {
    const { postId, authorId, commentId } = e.payload;
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.authorId === authorId) return;

    const actor = await this.actorCard(authorId);
    await this.notifications.create({
      userId: post.authorId,
      type: NotificationType.POST_COMMENTED,
      actorId: authorId,
      entityType: 'post',
      entityId: postId,
      data: actor.data,
    });
    await this.notifications.notify(post.authorId, {
      category: PUSH_CATEGORIES.FOLLOW,
      title: actor.name,
      body: 'Commented on your post',
      threadId: `post_${postId}`,
      badge: 'unread',
      data: { type: 'post_commented', postId, commentId, userId: authorId },
    });
  }

  private async actorCard(userId: string): Promise<{ name: string; data: Record<string, unknown> | null }> {
    const [card] = await this.profile.getCards([userId]);
    if (!card) return { name: 'Someone', data: null };
    return {
      name: card.fullName ?? card.username,
      data: { username: card.username, fullName: card.fullName, avatarUrl: card.avatarUrl },
    };
  }
}
