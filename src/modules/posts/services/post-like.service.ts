import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { PostLikedEvent, PostUnlikedEvent } from '../events/post.events';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class PostLikeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async like(postId: string, userId: string): Promise<void> {
    const post = await this.prisma.post.findFirst({ where: { id: postId, deletedAt: null } });
    if (!post) throw new NotFoundException('Post not found');

    try {
      await this.prisma.postLike.create({ data: { postId, userId } });
    } catch (err) {
      if (isUniqueConstraintError(err)) return;
      throw err;
    }
    await this.bus.publish(new PostLikedEvent({ postId, userId }));
  }

  async unlike(postId: string, userId: string): Promise<void> {
    const deleted = await this.prisma.postLike.deleteMany({ where: { postId, userId } });
    if (deleted.count > 0) {
      await this.bus.publish(new PostUnlikedEvent({ postId, userId }));
    }
  }
}
