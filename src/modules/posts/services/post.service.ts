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

@Injectable()
export class PostService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly permissions: PermissionResolver,
    @Optional() @Inject(PROFILE_SERVICE) private readonly profile?: IProfileService,
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
    await this.bus.publish(new PostCreatedEvent({ postId: post.id, authorId: post.authorId }));
    return post;
  }

  async deletePost(postId: string, actorId: string): Promise<void> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundException('Post not found');

    if (post.authorId !== actorId) {
      const granted = await this.permissions.resolveUserPermissions(actorId);
      if (!this.permissions.hasPermission(granted, 'post.moderate')) {
        throw new ForbiddenException('Not allowed to delete this post');
      }
    }

    await this.prisma.post.update({
      where: { id: postId },
      data: { status: PostStatus.REMOVED, deletedAt: new Date() },
    });
    await this.profile?.invalidateProfile(post.authorId).catch(() => undefined);
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
}
