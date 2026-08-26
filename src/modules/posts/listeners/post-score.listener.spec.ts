import { PostScoreListener } from './post-score.listener';
import {
  POST_EVENTS,
  PostCommentDeletedEvent,
  PostLikedEvent,
  PostCommentedEvent,
} from '../events/post.events';

describe('PostScoreListener', () => {
  function build() {
    const handlers = new Map<string, (e: unknown) => unknown>();
    const bus = {
      subscribe: jest.fn((name: string, fn: (e: unknown) => unknown) => handlers.set(name, fn)),
    };
    const prisma = { post: { update: jest.fn() } };
    const scoring = { computeScore: jest.fn().mockReturnValue(4.2) };
    const listener = new PostScoreListener(bus as any, prisma as any, scoring as any);
    listener.onModuleInit();
    return { listener, bus, prisma, scoring, handlers };
  }

  it('increments likeCount and recomputes score on a like event', async () => {
    const { prisma, scoring, handlers } = build();
    prisma.post.update.mockResolvedValueOnce({
      id: 'p1',
      likeCount: 3,
      commentCount: 0,
      createdAt: new Date(),
    });

    await handlers.get(POST_EVENTS.LIKED)!(new PostLikedEvent({ postId: 'p1', userId: 'u1' }));

    expect(prisma.post.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'p1' },
      data: { likeCount: { increment: 1 }, commentCount: { increment: 0 } },
    });
    expect(prisma.post.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'p1' },
      data: { score: 4.2 },
    });
    expect(scoring.computeScore).toHaveBeenCalledWith(3, 0, expect.any(Date));
  });

  it('increments commentCount on a comment event', async () => {
    const { prisma, handlers } = build();
    prisma.post.update.mockResolvedValueOnce({
      id: 'p1',
      likeCount: 0,
      commentCount: 1,
      createdAt: new Date(),
    });

    await handlers.get(POST_EVENTS.COMMENTED)!(
      new PostCommentedEvent({ postId: 'p1', authorId: 'u1', commentId: 'c1' }),
    );

    expect(prisma.post.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'p1' },
      data: { likeCount: { increment: 0 }, commentCount: { increment: 1 } },
    });
  });

  it('decrements commentCount on a comment_deleted event', async () => {
    const { prisma, handlers } = build();
    prisma.post.update.mockResolvedValueOnce({
      id: 'p1',
      likeCount: 0,
      commentCount: 0,
      createdAt: new Date(),
    });

    await handlers.get(POST_EVENTS.COMMENT_DELETED)!(
      new PostCommentDeletedEvent({ postId: 'p1', commentId: 'c1' }),
    );

    expect(prisma.post.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'p1' },
      data: { likeCount: { increment: 0 }, commentCount: { increment: -1 } },
    });
  });
});
