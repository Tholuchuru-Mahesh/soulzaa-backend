import { PostStatus } from '@prisma/client';
import { PostQueryService } from './post-query.service';

describe('PostQueryService', () => {
  function build() {
    const prisma = { post: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() } };
    const media = { resolve: jest.fn(async (key: string) => `https://cdn/${key}`) };
    const profile = { getCards: jest.fn(async (): Promise<any[]> => []) };
    const service = new PostQueryService(prisma as any, media as any, profile as any);
    return { service, prisma, media, profile };
  }

  const row = (overrides: Partial<any> = {}) => ({
    id: 'p1',
    authorId: 'u1',
    description: 'hi',
    likeCount: 2,
    commentCount: 1,
    createdAt: new Date('2026-08-25T00:00:00Z'),
    media: [{ key: 'post-images/u1/a.jpg', order: 0 }],
    likes: [],
    ...overrides,
  });

  it('marks a post as liked when the viewer has a like row', async () => {
    const { service, prisma, profile } = build();
    prisma.post.findMany.mockResolvedValue([row({ likes: [{ userId: 'viewer1' }] })]);
    prisma.post.count.mockResolvedValue(1);
    profile.getCards.mockResolvedValue([
      { id: 'u1', username: 'alice', fullName: 'Alice', avatarUrl: 'https://cdn/avatar.jpg' },
    ]);

    const feed = await service.getFeed('viewer1', 1, 20);

    expect(feed.items[0].likedByMe).toBe(true);
    expect(feed.items[0].author).toEqual({
      id: 'u1',
      username: 'alice',
      fullName: 'Alice',
      avatarUrl: 'https://cdn/avatar.jpg',
    });
    expect(feed.items[0].photoUrls).toEqual(['https://cdn/post-images/u1/a.jpg']);
  });

  it('queries only PUBLISHED, non-deleted posts ordered by score', async () => {
    const { service, prisma } = build();
    prisma.post.findMany.mockResolvedValue([]);
    prisma.post.count.mockResolvedValue(0);

    await service.getFeed('viewer1', 1, 20);

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: PostStatus.PUBLISHED, deletedAt: null },
        orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      }),
    );
  });

  it('returns null from getById when the post is missing', async () => {
    const { service, prisma } = build();
    prisma.post.findFirst.mockResolvedValue(null);
    expect(await service.getById('missing', 'viewer1')).toBeNull();
  });
});
