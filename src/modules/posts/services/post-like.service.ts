import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { PostLikedEvent, PostUnlikedEvent } from '../events/post.events';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class PostLikeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Optional() private readonly sockets?: SocketManager,
  ) {}

  async like(postId: string, userId: string): Promise<void> {
    const post = await this.prisma.post.findFirst({ where: { id: postId, deletedAt: null } });
    if (!post) throw new NotFoundException('Post not found');

    let created = false;
    try {
      await this.prisma.postLike.create({ data: { postId, userId } });
      created = true;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }

    const likeCount = this.prisma.postLike.count
      ? await this.prisma.postLike.count({ where: { postId } })
      : 0;
    if (created) {
      await this.bus.publish(new PostLikedEvent({ postId, userId }));
    }

    const payload = { postId, userId, liked: true, likeCount };
    this.sockets?.emitEverywhere('post.liked', payload);
    this.sockets?.emitEverywhere('post.like_updated', payload);
    this.sockets?.emitToNamespace('/notifications', 'post.liked', payload);
    this.sockets?.emitToNamespace('/notifications', 'post.like_updated', payload);
    this.sockets?.emitToNamespace('/chat', 'post.liked', payload);
    this.sockets?.emitToNamespace('/chat', 'post.like_updated', payload);
  }

  async unlike(postId: string, userId: string): Promise<void> {
    const deleted = await this.prisma.postLike.deleteMany({ where: { postId, userId } });
    const likeCount = this.prisma.postLike.count
      ? await this.prisma.postLike.count({ where: { postId } })
      : 0;
    if (deleted.count > 0) {
      await this.bus.publish(new PostUnlikedEvent({ postId, userId }));
    }

    const payload = { postId, userId, liked: false, likeCount };
    this.sockets?.emitEverywhere('post.unliked', payload);
    this.sockets?.emitEverywhere('post.like_updated', payload);
    this.sockets?.emitToNamespace('/notifications', 'post.unliked', payload);
    this.sockets?.emitToNamespace('/notifications', 'post.like_updated', payload);
    this.sockets?.emitToNamespace('/chat', 'post.unliked', payload);
    this.sockets?.emitToNamespace('/chat', 'post.like_updated', payload);
  }
}
