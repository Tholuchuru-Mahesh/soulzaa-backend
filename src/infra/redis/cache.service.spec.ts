import type { RedisClient } from './redis.constants';
import { CacheService } from './cache.service';

/**
 * CacheService is mostly a thin Redis wrapper and follows the infra convention of
 * not being unit-tested. `mget` is the exception: it has real branching (empty
 * short-circuit, per-key miss handling, parse-failure recovery) and the
 * video-room permission cache depends on that behaviour to stay fail-closed, so
 * it is pinned here.
 */
describe('CacheService.mget', () => {
  let client: { mget: jest.Mock };
  let service: CacheService;

  beforeEach(() => {
    client = { mget: jest.fn() };
    service = new CacheService(client as unknown as RedisClient);
  });

  it('returns an empty array without touching redis for no keys', async () => {
    await expect(service.mget<number>([])).resolves.toEqual([]);
    expect(client.mget).not.toHaveBeenCalled();
  });

  it('parses each JSON payload and maps misses to null, positionally', async () => {
    client.mget.mockResolvedValue(['42', null, '{"a":1}']);
    await expect(service.mget<unknown>(['k1', 'k2', 'k3'])).resolves.toEqual([42, null, { a: 1 }]);
    expect(client.mget).toHaveBeenCalledWith('k1', 'k2', 'k3');
  });

  // INCR stores a bare integer string; the permission version key is read through
  // the same JSON path as the entry, so this has to round-trip as a number.
  it('reads an INCR-written counter back as a number', async () => {
    client.mget.mockResolvedValue(['7']);
    await expect(service.mget<number>(['ver'])).resolves.toEqual([7]);
  });

  // A corrupt payload must degrade to a miss (which forces a database read),
  // never to a throw that would take down an authorization check.
  it('treats an unparseable payload as a miss', async () => {
    client.mget.mockResolvedValue(['{not json']);
    await expect(service.mget<unknown>(['k1'])).resolves.toEqual([null]);
  });
});
