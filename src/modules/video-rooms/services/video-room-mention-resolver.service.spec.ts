import { VideoRoomMentionResolver } from './video-room-mention-resolver.service';

const CTX = { roomId: 'r1', ownerId: 'owner-1', senderId: 'u1', max: 3 };

describe('VideoRoomMentionResolver', () => {
  let users: { findByUsername: jest.Mock };
  let roles: { listActiveByRoom: jest.Mock };
  let resolver: VideoRoomMentionResolver;

  beforeEach(() => {
    users = { findByUsername: jest.fn().mockResolvedValue(null) };
    roles = { listActiveByRoom: jest.fn().mockResolvedValue([]) };
    resolver = new VideoRoomMentionResolver(users as never, roles as never);
  });

  it('returns nothing when there are no mentions', async () => {
    const result = await resolver.resolve('just a message', CTX);
    expect(result).toEqual({ userIds: [], scope: null });
    expect(users.findByUsername).not.toHaveBeenCalled();
  });

  it('resolves @username to a user id', async () => {
    users.findByUsername.mockResolvedValue({ id: 'u2' });
    const result = await resolver.resolve('hey @alice', CTX);
    expect(users.findByUsername).toHaveBeenCalledWith('alice');
    expect(result.userIds).toEqual(['u2']);
  });

  it('never resolves a self-mention', async () => {
    users.findByUsername.mockResolvedValue({ id: 'u1' });
    const result = await resolver.resolve('@me talking to myself', CTX);
    expect(result.userIds).toEqual([]);
  });

  it('maps @owner to the room owner with an OWNER scope', async () => {
    const result = await resolver.resolve('@owner please look', CTX);
    expect(result).toEqual({ userIds: ['owner-1'], scope: 'OWNER' });
    // A group token must not be looked up as a username.
    expect(users.findByUsername).not.toHaveBeenCalledWith('owner');
  });

  it('maps @admins to the elevated grant holders', async () => {
    roles.listActiveByRoom.mockResolvedValue([{ userId: 'a1' }, { userId: 'a2' }]);
    const result = await resolver.resolve('@admins help', CTX);
    expect(result).toEqual({ userIds: ['a1', 'a2'], scope: 'ADMINS' });
  });

  it('caps the resolved set at max', async () => {
    users.findByUsername.mockImplementation((name: string) =>
      Promise.resolve({ id: `id-${name}` }),
    );
    const result = await resolver.resolve('@aaa @bbb @ccc @ddd @eee', CTX);
    expect(result.userIds).toHaveLength(3);
  });

  it('deduplicates a username repeated in one message', async () => {
    users.findByUsername.mockResolvedValue({ id: 'u2' });
    const result = await resolver.resolve('@alice and again @alice', CTX);
    expect(result.userIds).toEqual(['u2']);
    expect(users.findByUsername).toHaveBeenCalledTimes(1);
  });
});
