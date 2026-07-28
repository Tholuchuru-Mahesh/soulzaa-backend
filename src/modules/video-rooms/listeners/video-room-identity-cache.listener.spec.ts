import { USER_EVENTS } from 'src/modules/users/events/user.events';
import { VideoRoomIdentityCacheListener } from './video-room-identity-cache.listener';

describe('VideoRoomIdentityCacheListener', () => {
  let handlers: Record<string, (e: any) => unknown>;
  let bus: any;
  let identities: any;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, fn: (e: any) => unknown) => {
        handlers[name] = fn;
      }),
    };
    identities = { invalidate: jest.fn().mockResolvedValue(undefined) };
    new VideoRoomIdentityCacheListener(bus, identities).onModuleInit();
  });

  it('invalidates on user.profile_updated', async () => {
    await handlers[USER_EVENTS.PROFILE_UPDATED]({
      payload: { userId: 'u1', username: 'rahul_92', changed: ['fullName'] },
    });
    expect(identities.invalidate).toHaveBeenCalledWith('u1');
  });

  it('invalidates on user.avatar_updated', async () => {
    await handlers[USER_EVENTS.AVATAR_UPDATED]({
      payload: { userId: 'u2', kind: 'avatar', key: 'avatars/u2.jpg' },
    });
    expect(identities.invalidate).toHaveBeenCalledWith('u2');
  });

  it('does not invalidate on a cover-image change', async () => {
    await handlers[USER_EVENTS.AVATAR_UPDATED]({
      payload: { userId: 'u3', kind: 'cover', key: 'covers/u3.jpg' },
    });
    expect(identities.invalidate).not.toHaveBeenCalled();
  });

  it('swallows an invalidation failure so a Redis blip cannot break the bus', async () => {
    identities.invalidate.mockRejectedValue(new Error('redis down'));
    await expect(
      handlers[USER_EVENTS.PROFILE_UPDATED]({ payload: { userId: 'u1' } }),
    ).resolves.toBeUndefined();
  });
});
