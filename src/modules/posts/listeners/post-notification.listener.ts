import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
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

  // Notifications for posts (liked, commented) disabled per requirement.
  // Neither in-app nor push notification is dispatched for these events.
  private async onLiked(_e: PostLikedEvent): Promise<void> {
    // Disabled: neither in-app nor push notification is dispatched for post likes.
  }

  private async onCommented(_e: PostCommentedEvent): Promise<void> {
    // Disabled: neither in-app nor push notification is dispatched for post comments.
  }
}
