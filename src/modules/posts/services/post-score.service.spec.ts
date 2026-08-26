import { PostStatus } from '@prisma/client';
import { PostScoreService } from './post-score.service';

describe('PostScoreService', () => {
  describe('computeScore', () => {
    it('is zero for a brand-new post with no engagement', () => {
      const service = new PostScoreService({} as any);
      const now = new Date('2026-08-25T12:00:00Z');
      expect(service.computeScore(0, 0, now, now)).toBe(0);
    });

    it('increases with likes and comments', () => {
      const service = new PostScoreService({} as any);
      const now = new Date('2026-08-25T12:00:00Z');
      const createdAt = new Date('2026-08-25T10:00:00Z');
      const noEngagement = service.computeScore(0, 0, createdAt, now);
      const withEngagement = service.computeScore(5, 2, createdAt, now);
      expect(withEngagement).toBeGreaterThan(noEngagement);
    });

    it('decays as the post ages, holding engagement constant', () => {
      const service = new PostScoreService({} as any);
      const createdAt = new Date('2026-08-25T00:00:00Z');
      const scoreAt1h = service.computeScore(10, 5, createdAt, new Date('2026-08-25T01:00:00Z'));
      const scoreAt10h = service.computeScore(10, 5, createdAt, new Date('2026-08-25T10:00:00Z'));
      expect(scoreAt10h).toBeLessThan(scoreAt1h);
    });
  });

  describe('recomputeActivePosts', () => {
    it('recomputes score only for PUBLISHED posts created within the last 7 days', async () => {
      const prisma = {
        post: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'p1',
              likeCount: 3,
              commentCount: 1,
              createdAt: new Date('2026-08-24T00:00:00Z'),
            },
          ]),
          update: jest.fn(),
        },
      };
      const service = new PostScoreService(prisma as any);

      const result = await service.recomputeActivePosts(new Date('2026-08-25T00:00:00Z'));

      expect(result).toEqual({ recomputed: 1 });
      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: PostStatus.PUBLISHED, deletedAt: null }),
        }),
      );
      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { score: expect.any(Number) },
      });
    });
  });
});
