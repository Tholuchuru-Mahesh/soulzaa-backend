import { VideoRoomMemberRole } from '@prisma/client';
import type { CacheService } from 'src/infra/redis/cache.service';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { VideoRoomsMetrics } from '../video-rooms.metrics';
import { VideoRoomPermissionCache } from './video-room-permission-cache.service';

describe('VideoRoomPermissionCache', () => {
  let cache: { mget: jest.Mock; set: jest.Mock; increment: jest.Mock };
  let metrics: { incPermissionCacheHit: jest.Mock; incPermissionCacheMiss: jest.Mock };
  let subject: VideoRoomPermissionCache;

  const decision = {
    role: VideoRoomMemberRole.ADMIN,
    permissions: [VideoRoomPermission.KICK_USERS],
    temporary: false,
  };

  beforeEach(() => {
    cache = {
      mget: jest.fn().mockResolvedValue([null, null]),
      set: jest.fn(),
      increment: jest.fn(),
    };
    metrics = { incPermissionCacheHit: jest.fn(), incPermissionCacheMiss: jest.fn() };
    subject = new VideoRoomPermissionCache(
      cache as unknown as CacheService,
      metrics as unknown as VideoRoomsMetrics,
    );
  });

  it('reads both keys in a single MGET, room-tagged', async () => {
    cache.mget.mockResolvedValue([7, { ver: 7, ...decision }]);
    await subject.read('r1', 'u1');
    expect(cache.mget).toHaveBeenCalledWith([
      'video-room:{r1}:perm:ver',
      'video-room:{r1}:perm:u1',
    ]);
  });

  it('returns the entry and counts a hit when the versions agree', async () => {
    cache.mget.mockResolvedValue([7, { ver: 7, ...decision }]);
    await expect(subject.read('r1', 'u1')).resolves.toEqual({ ver: 7, ...decision });
    expect(metrics.incPermissionCacheHit).toHaveBeenCalledTimes(1);
    expect(metrics.incPermissionCacheMiss).not.toHaveBeenCalled();
  });

  it('misses when the entry was resolved under an older version', async () => {
    cache.mget.mockResolvedValue([8, { ver: 7, ...decision }]);
    await expect(subject.read('r1', 'u1')).resolves.toBeNull();
    expect(metrics.incPermissionCacheMiss).toHaveBeenCalledTimes(1);
  });

  it('misses when there is no entry', async () => {
    cache.mget.mockResolvedValue([7, null]);
    await expect(subject.read('r1', 'u1')).resolves.toBeNull();
    expect(metrics.incPermissionCacheMiss).toHaveBeenCalledTimes(1);
  });

  // The fail-closed property. An evicted or flushed version key must never let a
  // stale entry through, because that entry can carry an already-revoked grant.
  it('fails closed to a miss when the version key is absent', async () => {
    cache.mget.mockResolvedValue([null, { ver: 7, ...decision }]);
    await expect(subject.read('r1', 'u1')).resolves.toBeNull();
    expect(metrics.incPermissionCacheMiss).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the entry is malformed', async () => {
    cache.mget.mockResolvedValue([7, { garbage: true }]);
    await expect(subject.read('r1', 'u1')).resolves.toBeNull();
  });

  it('writes the entry stamped with the current version and a TTL', async () => {
    cache.mget.mockResolvedValue([4]);
    await subject.write('r1', 'u1', decision);
    expect(cache.set).toHaveBeenCalledWith('video-room:{r1}:perm:u1', { ver: 4, ...decision }, 300);
  });

  it('treats a missing version as 0 when writing', async () => {
    cache.mget.mockResolvedValue([null]);
    await subject.write('r1', 'u1', decision);
    expect(cache.set).toHaveBeenCalledWith('video-room:{r1}:perm:u1', { ver: 0, ...decision }, 300);
  });

  it('invalidates a whole room with a single INCR', async () => {
    cache.increment.mockResolvedValue(9);
    await subject.invalidateRoom('r1');
    expect(cache.increment).toHaveBeenCalledWith('video-room:{r1}:perm:ver');
    expect(cache.increment).toHaveBeenCalledTimes(1);
  });
});
