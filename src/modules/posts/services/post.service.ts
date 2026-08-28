import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Post, PostStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { STORAGE_CATEGORIES } from 'src/infra/storage/storage.constants';
import { PermissionResolver } from 'src/modules/authorization/services/permission-resolver.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { PostCreatedEvent } from '../events/post.events';

export interface CreatePostInput {
  authorId: string;
  description?: string;
  mediaKeys?: string[];
}

export interface UpdatePostInput {
  description?: string;
  mediaKeys?: string[];
}

@Injectable()
export class PostService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly permissions: PermissionResolver,
    @Optional() @Inject(PROFILE_SERVICE) private readonly profile?: IProfileService,
    @Optional() private readonly sockets?: SocketManager,
  ) {}

  async createPost(input: CreatePostInput): Promise<Post> {
    const description = input.description?.trim() || undefined;
    const mediaKeys = input.mediaKeys ?? [];
    if (!description && mediaKeys.length === 0) {
      throw new BadRequestException('A post needs a description or at least one photo.');
    }
    this.assertOwnedKeys(input.authorId, mediaKeys);

    const post = await this.prisma.post.create({
      data: {
        authorId: input.authorId,
        description: description ?? null,
        media: { create: mediaKeys.map((key, order) => ({ key, order })) },
      },
    });

    await this.profile?.invalidateProfile(input.authorId).catch(() => undefined);
    this.sockets?.emitToUserEverywhere(input.authorId, 'user.profile_updated', { userId: input.authorId });
    this.sockets?.emitToUserEverywhere(input.authorId, 'user.posts_updated', { userId: input.authorId });
    this.sockets?.emitToUserEverywhere(input.authorId, 'post.created', { postId: post.id, authorId: input.authorId });
    this.sockets?.emitToUserEverywhere(input.authorId, 'profile:updated', { userId: input.authorId });
    this.sockets?.emitEverywhere('post.created', { postId: post.id, authorId: input.authorId });
    this.sockets?.emitEverywhere('posts:feed_updated', { type: 'created', postId: post.id, authorId: input.authorId });
    this.sockets?.emitToNamespace('/notifications', 'post.created', { postId: post.id, authorId: input.authorId });
    this.sockets?.emitToNamespace('/notifications', 'posts:feed_updated', { type: 'created', postId: post.id, authorId: input.authorId });
    this.sockets?.emitToNamespace('/chat', 'post.created', { postId: post.id, authorId: input.authorId });
    this.sockets?.emitToNamespace('/chat', 'posts:feed_updated', { type: 'created', postId: post.id, authorId: input.authorId });
    await this.bus.publish(new PostCreatedEvent({ postId: post.id, authorId: post.authorId }));
    return post;
  }

  async updatePost(postId: string, actorId: string, input: UpdatePostInput): Promise<Post> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: { media: true },
    });
    if (!post || post.deletedAt || post.status === PostStatus.REMOVED) {
      throw new NotFoundException('Post not found');
    }

    if (post.authorId !== actorId) {
      const granted = await this.permissions.resolveUserPermissions(actorId);
      if (!this.permissions.hasPermission(granted, 'post.moderate')) {
        throw new ForbiddenException('Not allowed to edit this post');
      }
    }

    const description =
      input.description !== undefined ? input.description.trim() || null : post.description;

    if (input.mediaKeys !== undefined) {
      const existingKeySet = new Set(post.media.map((m) => m.key));
      const resolvedKeys = input.mediaKeys.map((item) =>
        this.extractAndAssertKey(post.authorId, item, existingKeySet),
      );

      if (!description && resolvedKeys.length === 0) {
        throw new BadRequestException('A post needs a description or at least one photo.');
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.postMedia.deleteMany({ where: { postId } });
        if (resolvedKeys.length > 0) {
          await tx.postMedia.createMany({
            data: resolvedKeys.map((key, order) => ({ postId, key, order })),
          });
        }
        await tx.post.update({
          where: { id: postId },
          data: { description },
        });
      });
    } else {
      if (!description && post.media.length === 0) {
        throw new BadRequestException('A post needs a description or at least one photo.');
      }
      await this.prisma.post.update({
        where: { id: postId },
        data: { description },
      });
    }

    await this.profile?.invalidateProfile(post.authorId).catch(() => undefined);
    this.sockets?.emitToUserEverywhere(post.authorId, 'user.profile_updated', { userId: post.authorId });
    this.sockets?.emitToUserEverywhere(post.authorId, 'user.posts_updated', { userId: post.authorId });
    this.sockets?.emitToUserEverywhere(post.authorId, 'post.updated', { postId: post.id, authorId: post.authorId });
    this.sockets?.emitToUserEverywhere(post.authorId, 'profile:updated', { userId: post.authorId });
    this.sockets?.emitEverywhere('post.updated', { postId: post.id, authorId: post.authorId });
    this.sockets?.emitEverywhere('posts:feed_updated', { type: 'updated', postId: post.id, authorId: post.authorId });
    this.sockets?.emitToNamespace('/notifications', 'post.updated', { postId: post.id, authorId: post.authorId });
    this.sockets?.emitToNamespace('/notifications', 'posts:feed_updated', { type: 'updated', postId: post.id, authorId: post.authorId });
    this.sockets?.emitToNamespace('/chat', 'post.updated', { postId: post.id, authorId: post.authorId });
    this.sockets?.emitToNamespace('/chat', 'posts:feed_updated', { type: 'updated', postId: post.id, authorId: post.authorId });
    return (await this.prisma.post.findUnique({ where: { id: postId } }))!;
  }

  async deletePost(postId: string, actorId: string): Promise<void> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');

    if (post.authorId !== actorId) {
      const granted = await this.permissions.resolveUserPermissions(actorId);
      if (!this.permissions.hasPermission(granted, 'post.moderate')) {
        throw new ForbiddenException('Not allowed to delete this post');
      }
    }

    if (post.deletedAt || post.status === PostStatus.REMOVED) {
      return;
    }

    await this.prisma.post.update({
      where: { id: postId },
      data: { status: PostStatus.REMOVED, deletedAt: new Date() },
    });
    await this.profile?.invalidateProfile(post.authorId).catch(() => undefined);
    this.sockets?.emitToUserEverywhere(post.authorId, 'user.profile_updated', { userId: post.authorId });
    this.sockets?.emitToUserEverywhere(post.authorId, 'user.posts_updated', { userId: post.authorId });
    this.sockets?.emitToUserEverywhere(post.authorId, 'post.deleted', { postId: post.id, authorId: post.authorId });
    this.sockets?.emitToUserEverywhere(post.authorId, 'profile:updated', { userId: post.authorId });
    this.sockets?.emitEverywhere('post.deleted', { postId: post.id, authorId: post.authorId });
    this.sockets?.emitEverywhere('posts:feed_updated', { type: 'deleted', postId: post.id, authorId: post.authorId });
    this.sockets?.emitToNamespace('/notifications', 'post.deleted', { postId: post.id, authorId: post.authorId });
    this.sockets?.emitToNamespace('/notifications', 'posts:feed_updated', { type: 'deleted', postId: post.id, authorId: post.authorId });
    this.sockets?.emitToNamespace('/chat', 'post.deleted', { postId: post.id, authorId: post.authorId });
    this.sockets?.emitToNamespace('/chat', 'posts:feed_updated', { type: 'deleted', postId: post.id, authorId: post.authorId });
  }

  /** Each staged photo's key must have been minted for this user by the storage presign flow. */
  private assertOwnedKeys(authorId: string, mediaKeys: string[]): void {
    const prefix = `${STORAGE_CATEGORIES.POST_IMAGE}/${authorId}/`;
    for (const key of mediaKeys) {
      if (!key.startsWith(prefix)) {
        throw new BadRequestException('One of the provided photos does not belong to you.');
      }
    }
  }

  private extractAndAssertKey(
    authorId: string,
    item: string,
    existingKeys: Set<string>,
  ): string {
    const prefix = `${STORAGE_CATEGORIES.POST_IMAGE}/${authorId}/`;
    if (existingKeys.has(item)) return item;
    if (item.startsWith(prefix)) return item;
    const idx = item.indexOf(prefix);
    if (idx !== -1) {
      const key = item.substring(idx).split('?')[0];
      return key;
    }
    throw new BadRequestException('One of the provided photos does not belong to you.');
  }
}
