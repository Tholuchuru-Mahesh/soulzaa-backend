import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  POST_EVENTS,
  type PostCommentDeletedEvent,
  type PostCommentedEvent,
  type PostLikedEvent,
  type PostUnlikedEvent,
} from '../events/post.events';
import { PostScoreService } from '../services/post-score.service';

@Injectable()
export class PostScoreListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly prisma: PrismaService,
    private readonly scoring: PostScoreService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PostLikedEvent>(POST_EVENTS.LIKED, (e) => this.bump(e.payload.postId, 1, 0));
    this.bus.subscribe<PostUnlikedEvent>(POST_EVENTS.UNLIKED, (e) => this.bump(e.payload.postId, -1, 0));
    this.bus.subscribe<PostCommentedEvent>(POST_EVENTS.COMMENTED, (e) => this.bump(e.payload.postId, 0, 1));
    this.bus.subscribe<PostCommentDeletedEvent>(POST_EVENTS.COMMENT_DELETED, (e) => this.bump(e.payload.postId, 0, -1));
  }

  private async bump(postId: string, likeDelta: number, commentDelta: number): Promise<void> {
    const post = await this.prisma.post.update({
      where: { id: postId },
      data: { likeCount: { increment: likeDelta }, commentCount: { increment: commentDelta } },
    });
    const score = this.scoring.computeScore(post.likeCount, post.commentCount, post.createdAt);
    await this.prisma.post.update({ where: { id: postId }, data: { score } });
  }
}
