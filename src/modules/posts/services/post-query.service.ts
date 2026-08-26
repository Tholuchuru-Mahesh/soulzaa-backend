import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PostStatus } from '@prisma/client';
import { buildPaginated, normalizePagination } from 'src/common/utils/pagination.util';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import type { PostSummary } from '../interfaces/post-summary.interface';

const POST_INCLUDE = (viewerId: string) =>
  Prisma.validator<Prisma.PostInclude>()({
    media: { orderBy: { order: 'asc' } },
    likes: { where: { userId: viewerId }, select: { userId: true } },
  });

type PostRow = Prisma.PostGetPayload<{ include: ReturnType<typeof POST_INCLUDE> }>;

@Injectable()
export class PostQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaUrlResolver,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
  ) {}

  async getFeed(viewerId: string, page?: number, limit?: number): Promise<Paginated<PostSummary>> {
    const { page: p, limit: l, skip } = normalizePagination({ page, limit });
    const where = { status: PostStatus.PUBLISHED, deletedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.post.findMany({
        where,
        orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: l,
        include: POST_INCLUDE(viewerId),
      }),
      this.prisma.post.count({ where }),
    ]);
    return buildPaginated(await this.toSummaries(rows), total, p, l);
  }

  async getUserPosts(authorId: string, viewerId: string, page?: number, limit?: number): Promise<Paginated<PostSummary>> {
    const { page: p, limit: l, skip } = normalizePagination({ page, limit });
    const where = { authorId, status: PostStatus.PUBLISHED, deletedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.post.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip,
        take: l,
        include: POST_INCLUDE(viewerId),
      }),
      this.prisma.post.count({ where }),
    ]);
    return buildPaginated(await this.toSummaries(rows), total, p, l);
  }

  async getById(postId: string, viewerId: string): Promise<PostSummary | null> {
    const row = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      include: POST_INCLUDE(viewerId),
    });
    if (!row) return null;
    const [summary] = await this.toSummaries([row]);
    return summary;
  }

  private async toSummaries(rows: PostRow[]): Promise<PostSummary[]> {
    const authorIds = [...new Set(rows.map((r) => r.authorId))];
    const cards = await this.profile.getCards(authorIds);
    const cardById = new Map(cards.map((c) => [c.id, c]));

    return Promise.all(
      rows.map(async (row) => {
        const photoUrls = (
          await Promise.all(row.media.map((m) => this.media.resolve(m.key)))
        ).filter((u): u is string => !!u);
        const card = cardById.get(row.authorId);
        return {
          id: row.id,
          description: row.description,
          photoUrls,
          likeCount: row.likeCount,
          commentCount: row.commentCount,
          likedByMe: row.likes.length > 0,
          createdAt: row.createdAt,
          author: {
            id: row.authorId,
            username: card?.username ?? 'user',
            fullName: card?.fullName ?? null,
            avatarUrl: card?.avatarUrl ?? null,
          },
        };
      }),
    );
  }
}
