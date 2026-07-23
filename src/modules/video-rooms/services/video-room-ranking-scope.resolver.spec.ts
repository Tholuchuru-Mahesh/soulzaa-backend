import { VideoRoomRankingScopeResolver } from './video-room-ranking-scope.resolver';

describe('VideoRoomRankingScopeResolver', () => {
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let repo: { findUserGeo: jest.Mock };
  let resolver: VideoRoomRankingScopeResolver;

  beforeEach(() => {
    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(1),
    };
    repo = {
      findUserGeo: jest.fn().mockResolvedValue([{ userId: 'u1', country: 'IN', city: 'city-9' }]),
    };
    resolver = new VideoRoomRankingScopeResolver(cache as never, repo as never);
  });

  describe('geoFor', () => {
    it('reads through to the repository on a cache miss and caches the result', async () => {
      await expect(resolver.geoFor('u1')).resolves.toEqual({ country: 'IN', city: 'city-9' });
      expect(repo.findUserGeo).toHaveBeenCalledWith(['u1']);
      expect(cache.set).toHaveBeenCalledWith(
        'vrank:geo:u1',
        { country: 'IN', city: 'city-9' },
        expect.any(Number),
      );
    });

    it('serves a cached value without touching the database', async () => {
      cache.get.mockResolvedValue({ country: 'US', city: null });
      await expect(resolver.geoFor('u1')).resolves.toEqual({ country: 'US', city: null });
      expect(repo.findUserGeo).not.toHaveBeenCalled();
    });

    it('caches a null geo so an unknown user is not looked up on every gift', async () => {
      repo.findUserGeo.mockResolvedValue([]);
      await expect(resolver.geoFor('ghost')).resolves.toEqual({ country: null, city: null });
      expect(cache.set).toHaveBeenCalledWith(
        'vrank:geo:ghost',
        { country: null, city: null },
        expect.any(Number),
      );
    });

    it('degrades to an empty geo when the lookup throws, rather than failing the write', async () => {
      repo.findUserGeo.mockRejectedValue(new Error('db down'));
      await expect(resolver.geoFor('u1')).resolves.toEqual({ country: null, city: null });
    });

    it('falls through to the repository when the cache read rejects, rather than throwing', async () => {
      cache.get.mockRejectedValue(new Error('redis timeout'));
      await expect(resolver.geoFor('u1')).resolves.toEqual({ country: 'IN', city: 'city-9' });
      expect(repo.findUserGeo).toHaveBeenCalledWith(['u1']);
    });

    it('still resolves normally when the cache write rejects', async () => {
      cache.set.mockRejectedValue(new Error('redis timeout'));
      await expect(resolver.geoFor('u1')).resolves.toEqual({ country: 'IN', city: 'city-9' });
    });
  });

  describe('geoForMany', () => {
    it('issues one query for every uncached user', async () => {
      repo.findUserGeo.mockResolvedValue([
        { userId: 'u1', country: 'IN', city: 'c1' },
        { userId: 'u2', country: 'US', city: null },
      ]);
      const map = await resolver.geoForMany(['u1', 'u2']);
      expect(repo.findUserGeo).toHaveBeenCalledTimes(1);
      expect(repo.findUserGeo).toHaveBeenCalledWith(['u1', 'u2']);
      expect(map.get('u1')).toEqual({ country: 'IN', city: 'c1' });
      expect(map.get('u2')).toEqual({ country: 'US', city: null });
    });

    it('queries only the users the cache missed', async () => {
      cache.get.mockImplementation((k: string) =>
        Promise.resolve(k === 'vrank:geo:u1' ? { country: 'IN', city: 'c1' } : null),
      );
      repo.findUserGeo.mockResolvedValue([{ userId: 'u2', country: 'US', city: null }]);
      await resolver.geoForMany(['u1', 'u2']);
      expect(repo.findUserGeo).toHaveBeenCalledWith(['u2']);
    });

    it('does not query at all for an empty list', async () => {
      await expect(resolver.geoForMany([])).resolves.toEqual(new Map());
      expect(repo.findUserGeo).not.toHaveBeenCalled();
    });

    it('de-duplicates input ids before querying the repository', async () => {
      repo.findUserGeo.mockResolvedValue([
        { userId: 'u1', country: 'IN', city: 'c1' },
        { userId: 'u2', country: 'US', city: null },
      ]);
      await resolver.geoForMany(['u1', 'u1', 'u2']);
      expect(repo.findUserGeo).toHaveBeenCalledTimes(1);
      expect(repo.findUserGeo).toHaveBeenCalledWith(['u1', 'u2']);
    });

    it('fills every requested id in the returned Map even when the database returns fewer rows', async () => {
      repo.findUserGeo.mockResolvedValue([{ userId: 'u1', country: 'IN', city: 'c1' }]);
      const map = await resolver.geoForMany(['u1', 'u2', 'u3']);
      expect(map.size).toBe(3);
      expect(map.get('u1')).toEqual({ country: 'IN', city: 'c1' });
      expect(map.get('u2')).toEqual({ country: null, city: null });
      expect(map.get('u3')).toEqual({ country: null, city: null });
    });

    it('falls through to the repository when a cache read rejects, rather than throwing', async () => {
      cache.get.mockRejectedValue(new Error('redis timeout'));
      repo.findUserGeo.mockResolvedValue([{ userId: 'u1', country: 'IN', city: 'c1' }]);
      await expect(resolver.geoForMany(['u1'])).resolves.toEqual(
        new Map([['u1', { country: 'IN', city: 'c1' }]]),
      );
    });

    it('still resolves normally when a cache write rejects', async () => {
      cache.set.mockRejectedValue(new Error('redis timeout'));
      repo.findUserGeo.mockResolvedValue([{ userId: 'u1', country: 'IN', city: 'c1' }]);
      await expect(resolver.geoForMany(['u1'])).resolves.toEqual(
        new Map([['u1', { country: 'IN', city: 'c1' }]]),
      );
    });
  });

  describe('scopesFor', () => {
    it('always includes global, and adds country/city/room when known', async () => {
      await expect(resolver.scopesFor('u1', 'room-1')).resolves.toEqual([
        'g',
        'c:IN',
        'y:city-9',
        'r:room-1',
      ]);
    });

    it('omits geography scopes the user has not set', async () => {
      repo.findUserGeo.mockResolvedValue([{ userId: 'u1', country: null, city: null }]);
      await expect(resolver.scopesFor('u1')).resolves.toEqual(['g']);
    });

    it('omits the room scope when no room is supplied', async () => {
      await expect(resolver.scopesFor('u1')).resolves.toEqual(['g', 'c:IN', 'y:city-9']);
    });
  });

  it('drops the cached entry on invalidate', async () => {
    await resolver.invalidate('u1');
    expect(cache.del).toHaveBeenCalledWith('vrank:geo:u1');
  });

  it('does not throw when the cache delete rejects during invalidate', async () => {
    cache.del.mockRejectedValue(new Error('redis timeout'));
    await expect(resolver.invalidate('u1')).resolves.toBeUndefined();
  });
});
