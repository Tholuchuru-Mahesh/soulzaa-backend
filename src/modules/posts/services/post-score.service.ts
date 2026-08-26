import { Injectable } from '@nestjs/common';
import { PostStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

const LIKE_WEIGHT = 2;
const COMMENT_WEIGHT = 3;
const GRAVITY = 1.5;
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class PostScoreService {
  constructor(private readonly prisma: PrismaService) {}

  computeScore(likeCount: number, commentCount: number, createdAt: Date, now: Date = new Date()): number {
    const hoursSincePosted = Math.max(0, (now.getTime() - createdAt.getTime()) / 3_600_000);
    const weight = likeCount * LIKE_WEIGHT + commentCount * COMMENT_WEIGHT;
    return weight / Math.pow(hoursSincePosted + 2, GRAVITY);
  }

  async recomputeActivePosts(now: Date = new Date()): Promise<{ recomputed: number }> {
    const since = new Date(now.getTime() - ACTIVE_WINDOW_MS);
    const posts = await this.prisma.post.findMany({
      where: { status: PostStatus.PUBLISHED, deletedAt: null, createdAt: { gte: since } },
      select: { id: true, likeCount: true, commentCount: true, createdAt: true },
    });

    for (const post of posts) {
      const score = this.computeScore(post.likeCount, post.commentCount, post.createdAt, now);
      await this.prisma.post.update({ where: { id: post.id }, data: { score } });
    }

    return { recomputed: posts.length };
  }
}
