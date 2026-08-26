import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PostReport, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class PostReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(postId: string, reporterId: string, reason: string): Promise<PostReport> {
    const post = await this.prisma.post.findFirst({ where: { id: postId, deletedAt: null } });
    if (!post) throw new NotFoundException('Post not found');

    try {
      return await this.prisma.postReport.create({ data: { postId, reporterId, reason } });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictException('You already reported this post.');
      }
      throw err;
    }
  }
}
