import { ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated, normalizePagination } from 'src/common/utils/pagination.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { PermissionResolver } from 'src/modules/authorization/services/permission-resolver.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { PostCommentDeletedEvent, PostCommentedEvent } from '../events/post.events';
import type { PostCommentView } from '../interfaces/post-summary.interface';

@Injectable()
export class PostCommentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
    private readonly permissions: PermissionResolver,
    @Optional() private readonly sockets?: SocketManager,
  ) {}

  async addComment(postId: string, authorId: string, body: string): Promise<PostCommentView> {
    const post = await this.prisma.post.findFirst({ where: { id: postId, deletedAt: null } });
    if (!post) throw new NotFoundException('Post not found');

    const comment = await this.prisma.postComment.create({ data: { postId, authorId, body } });
    await this.bus.publish(new PostCommentedEvent({ postId, authorId, commentId: comment.id }));

    const [card] = await this.profile.getCards([authorId]);
    const commentView: PostCommentView = {
      id: comment.id,
      postId: comment.postId,
      body: comment.body,
      createdAt: comment.createdAt,
      author: {
        id: authorId,
        username: card?.username ?? 'user',
        fullName: card?.fullName ?? null,
        avatarUrl: card?.avatarUrl ?? null,
      },
    };

    const commentCount = this.prisma.postComment.count
      ? await this.prisma.postComment.count({ where: { postId, deletedAt: null } })
      : 0;
    const payload = { postId, comment: commentView, commentCount };
    this.sockets?.emitEverywhere('post.commented', payload);
    this.sockets?.emitEverywhere('post.comment_added', payload);
    this.sockets?.emitToNamespace('/notifications', 'post.commented', payload);
    this.sockets?.emitToNamespace('/notifications', 'post.comment_added', payload);
    this.sockets?.emitToNamespace('/chat', 'post.commented', payload);
    this.sockets?.emitToNamespace('/chat', 'post.comment_added', payload);

    return commentView;
  }

  async updateComment(commentId: string, actorId: string, body: string): Promise<PostCommentView> {
    const comment = await this.prisma.postComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deletedAt) throw new NotFoundException('Comment not found');

    if (comment.authorId !== actorId) {
      const granted = await this.permissions.resolveUserPermissions(actorId);
      if (!this.permissions.hasPermission(granted, 'post.moderate')) {
        throw new ForbiddenException('Not allowed to edit this comment');
      }
    }

    const updated = await this.prisma.postComment.update({
      where: { id: commentId },
      data: { body },
    });

    const [card] = await this.profile.getCards([comment.authorId]);
    const commentView: PostCommentView = {
      id: updated.id,
      postId: updated.postId,
      body: updated.body,
      createdAt: updated.createdAt,
      author: {
        id: comment.authorId,
        username: card?.username ?? 'user',
        fullName: card?.fullName ?? null,
        avatarUrl: card?.avatarUrl ?? null,
      },
    };

    const commentCount = this.prisma.postComment.count
      ? await this.prisma.postComment.count({ where: { postId: comment.postId, deletedAt: null } })
      : 0;
    const payload = { postId: comment.postId, comment: commentView, commentCount };
    this.sockets?.emitEverywhere('post.comment_updated', payload);
    this.sockets?.emitToNamespace('/notifications', 'post.comment_updated', payload);
    this.sockets?.emitToNamespace('/chat', 'post.comment_updated', payload);

    return commentView;
  }

  async listComments(
    postId: string,
    page?: number,
    limit?: number,
  ): Promise<Paginated<PostCommentView>> {
    const { page: p, limit: l, skip } = normalizePagination({ page, limit });
    const where = { postId, deletedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.postComment.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take: l }),
      this.prisma.postComment.count({ where }),
    ]);

    const authorIds = [...new Set(rows.map((r) => r.authorId))];
    const cards = await this.profile.getCards(authorIds);
    const cardById = new Map(cards.map((c) => [c.id, c]));

    const items: PostCommentView[] = rows.map((r) => {
      const card = cardById.get(r.authorId);
      return {
        id: r.id,
        postId: r.postId,
        body: r.body,
        createdAt: r.createdAt,
        author: {
          id: r.authorId,
          username: card?.username ?? 'user',
          fullName: card?.fullName ?? null,
          avatarUrl: card?.avatarUrl ?? null,
        },
      };
    });

    return buildPaginated(items, total, p, l);
  }

  async deleteComment(commentId: string, actorId: string): Promise<void> {
    const comment = await this.prisma.postComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deletedAt) throw new NotFoundException('Comment not found');

    if (comment.authorId !== actorId) {
      const granted = await this.permissions.resolveUserPermissions(actorId);
      if (!this.permissions.hasPermission(granted, 'post.moderate')) {
        throw new ForbiddenException('Not allowed to delete this comment');
      }
    }

    await this.prisma.postComment.update({
      where: { id: commentId },
      data: { deletedAt: new Date() },
    });
    const commentCount = this.prisma.postComment.count
      ? await this.prisma.postComment.count({ where: { postId: comment.postId, deletedAt: null } })
      : 0;
    await this.bus.publish(new PostCommentDeletedEvent({ postId: comment.postId, commentId }));

    const payload = { postId: comment.postId, commentId, commentCount };
    this.sockets?.emitEverywhere('post.comment_deleted', payload);
    this.sockets?.emitToNamespace('/notifications', 'post.comment_deleted', payload);
    this.sockets?.emitToNamespace('/chat', 'post.comment_deleted', payload);
  }
}
