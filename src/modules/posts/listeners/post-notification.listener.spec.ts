import { NotificationType } from '@prisma/client';
import { PostNotificationListener } from './post-notification.listener';
import { POST_EVENTS, PostLikedEvent } from '../events/post.events';

describe('PostNotificationListener', () => {
  function build() {
    const handlers = new Map<string, (e: unknown) => unknown>();
    const bus = {
      subscribe: jest.fn((name: string, fn: (e: unknown) => unknown) => handlers.set(name, fn)),
    };
    const notifications = { create: jest.fn(), notify: jest.fn() };
    const profile = { getCards: jest.fn() };
    const prisma = { post: { findUnique: jest.fn() } };
    const listener = new PostNotificationListener(
      bus as any,
      notifications as any,
      profile as any,
      prisma as any,
    );
    listener.onModuleInit();
    return { listener, bus, notifications, profile, prisma, handlers };
  }

  it('notifies the post author when someone else likes their post', async () => {
    const { notifications, profile, prisma, handlers } = build();
    prisma.post.findUnique.mockResolvedValue({ id: 'p1', authorId: 'author1' });
    profile.getCards.mockResolvedValue([
      { id: 'liker1', username: 'bob', fullName: 'Bob', avatarUrl: null },
    ]);

    await handlers.get(POST_EVENTS.LIKED)!(new PostLikedEvent({ postId: 'p1', userId: 'liker1' }));

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'author1',
        type: NotificationType.POST_LIKED,
        actorId: 'liker1',
      }),
    );
    expect(notifications.notify).toHaveBeenCalled();
  });

  it('does not notify when the author likes their own post', async () => {
    const { notifications, prisma, handlers } = build();
    prisma.post.findUnique.mockResolvedValue({ id: 'p1', authorId: 'author1' });

    await handlers.get(POST_EVENTS.LIKED)!(new PostLikedEvent({ postId: 'p1', userId: 'author1' }));

    expect(notifications.create).not.toHaveBeenCalled();
  });
});
