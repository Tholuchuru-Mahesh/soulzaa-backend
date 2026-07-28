import { VideoRoomIdentityCache } from './video-room-identity-cache.service';

const IDENTITY = {
  displayName: 'Rahul',
  avatarUrl: 'https://cdn/a.jpg',
  username: 'rahul_92',
  level: 24,
  vipLevel: 3,
  verified: true,
};

describe('VideoRoomIdentityCache', () => {
  let cache: any;
  let profiles: any;
  let svc: VideoRoomIdentityCache;

  beforeEach(() => {
    cache = {
      mget: jest.fn().mockResolvedValue([null]),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(1),
    };
    profiles = {
      resolvePublicIdentities: jest.fn().mockResolvedValue(new Map([['u1', IDENTITY]])),
    };
    svc = new VideoRoomIdentityCache(cache, profiles);
  });

  it('returns an empty map without touching Redis for no ids', async () => {
    expect((await svc.resolve([])).size).toBe(0);
    expect(cache.mget).not.toHaveBeenCalled();
  });

  it('resolves a cache miss through the profile service and caches it', async () => {
    const out = await svc.resolve(['u1']);

    expect(cache.mget).toHaveBeenCalledWith(['video-room:identity:{u1}']);
    expect(profiles.resolvePublicIdentities).toHaveBeenCalledWith(['u1']);
    expect(cache.set).toHaveBeenCalledWith('video-room:identity:{u1}', IDENTITY, 60);
    expect(out.get('u1')).toEqual(IDENTITY);
  });

  it('serves a cache hit without calling the profile service', async () => {
    cache.mget.mockResolvedValue([IDENTITY]);

    const out = await svc.resolve(['u1']);

    expect(profiles.resolvePublicIdentities).not.toHaveBeenCalled();
    expect(out.get('u1')).toEqual(IDENTITY);
  });

  it('queries only the missing ids on a partial hit', async () => {
    cache.mget.mockResolvedValue([IDENTITY, null]);
    profiles.resolvePublicIdentities.mockResolvedValue(
      new Map([['u2', { ...IDENTITY, username: 'priya' }]]),
    );

    const out = await svc.resolve(['u1', 'u2']);

    expect(profiles.resolvePublicIdentities).toHaveBeenCalledWith(['u2']);
    expect(out.size).toBe(2);
  });

  it('dedupes ids and drops empty ones before querying', async () => {
    await svc.resolve(['u1', 'u1', '']);
    expect(cache.mget).toHaveBeenCalledWith(['video-room:identity:{u1}']);
  });

  it('omits ids the profile service could not resolve rather than inventing them', async () => {
    profiles.resolvePublicIdentities.mockResolvedValue(new Map());
    const out = await svc.resolve(['ghost']);
    expect(out.has('ghost')).toBe(false);
  });

  it('invalidate deletes the cached key', async () => {
    await svc.invalidate('u1');
    expect(cache.del).toHaveBeenCalledWith('video-room:identity:{u1}');
  });
});
