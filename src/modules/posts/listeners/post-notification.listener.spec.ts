import { PostNotificationListener } from './post-notification.listener';
import { POST_EVENTS, PostCommentedEvent, PostLikedEvent } from '../events/post.events';

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

  it('does not dispatch in-app or push notifications when a post is liked', async () => {
    const { notifications, handlers } = build();

    await handlers.get(POST_EVENTS.LIKED)!(new PostLikedEvent({ postId: 'p1', userId: 'liker1' }));

    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('does not dispatch in-app or push notifications when the author likes their own post', async () => {
    const { notifications, handlers } = build();

    await handlers.get(POST_EVENTS.LIKED)!(new PostLikedEvent({ postId: 'p1', userId: 'author1' }));

    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('does not dispatch in-app or push notifications when a post is commented on', async () => {
    const { notifications, handlers } = build();

    await handlers.get(POST_EVENTS.COMMENTED)!(
      new PostCommentedEvent({ postId: 'p1', authorId: 'author1', commentId: 'c1' }),
    );

    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
