import { LeaderboardCache } from './leaderboard-cache.service';

describe('LeaderboardCache', () => {
  const cacheKey = 'vrank:cache:{g|hosts}:daily:20260722:1';
  let cache: { get: jest.Mock; set: jest.Mock };
  let store: { version: jest.Mock };
  let subject: LeaderboardCache;

  beforeEach(() => {
    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
    store = { version: jest.fn().mockResolvedValue(4) };
    subject = new LeaderboardCache(cache as never, store as never);
  });

  it('returns null and counts a miss when nothing is cached', async () => {
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toBeNull();
    expect(cache.get).toHaveBeenCalledWith(cacheKey);
    expect(subject.snapshotCounters()).toEqual({ hits: 0, misses: 1 });
  });

  it('returns the payload and counts a hit when the version stamp matches', async () => {
    cache.get.mockResolvedValue({ version: 4, dateKey: '20260722', payload: [{ rank: 1 }] });
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toEqual([
      { rank: 1 },
    ]);
    expect(subject.snapshotCounters()).toEqual({ hits: 1, misses: 0 });
  });

  it('reads the version from the live store using the namespace, scope, and dimension of the read', async () => {
    cache.get.mockResolvedValue({ version: 4, dateKey: '20260722', payload: [{ rank: 1 }] });
    await subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1);
    expect(store.version).toHaveBeenCalledTimes(1);
    expect(store.version).toHaveBeenCalledWith('vrank', 'g', 'hosts');
  });

  it('invalidates a previously valid entry once the store reports a newer version', async () => {
    cache.get.mockResolvedValue({ version: 4, dateKey: '20260722', payload: [{ rank: 1 }] });

    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toEqual([
      { rank: 1 },
    ]);
    expect(subject.snapshotCounters()).toEqual({ hits: 1, misses: 0 });

    store.version.mockResolvedValue(5);
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toBeNull();
    expect(subject.snapshotCounters()).toEqual({ hits: 0, misses: 1 });
  });

  it('treats a stale version stamp as a miss', async () => {
    cache.get.mockResolvedValue({ version: 3, dateKey: '20260722', payload: [{ rank: 1 }] });
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toBeNull();
    expect(subject.snapshotCounters()).toEqual({ hits: 0, misses: 1 });
  });

  it('treats a mismatched dateKey as a miss even at the right version', async () => {
    cache.get.mockResolvedValue({ version: 4, dateKey: '20260721', payload: [{ rank: 1 }] });
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toBeNull();
  });

  it('stamps the current version and dateKey on write', async () => {
    await subject.write('vrank', 'g', 'hosts', 'daily', '20260722', 1, [{ rank: 1 }], 30);
    expect(cache.set).toHaveBeenCalledWith(
      cacheKey,
      { version: 4, dateKey: '20260722', payload: [{ rank: 1 }] },
      30,
    );
  });

  it('stamps whatever version the store reports at write time, not the suite default', async () => {
    store.version.mockResolvedValue(9);
    await subject.write('vrank', 'g', 'hosts', 'daily', '20260722', 1, [{ rank: 1 }], 30);
    expect(store.version).toHaveBeenCalledWith('vrank', 'g', 'hosts');
    expect(cache.set).toHaveBeenCalledWith(
      cacheKey,
      { version: 9, dateKey: '20260722', payload: [{ rank: 1 }] },
      30,
    );
  });

  it('degrades to a miss rather than throwing when Redis is down', async () => {
    cache.get.mockRejectedValue(new Error('CONNRESET'));
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toBeNull();
    expect(subject.snapshotCounters()).toEqual({ hits: 0, misses: 1 });
  });

  it('degrades to a miss rather than throwing when the version store is down', async () => {
    store.version.mockRejectedValue(new Error('version store unavailable'));
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toBeNull();
    expect(subject.snapshotCounters()).toEqual({ hits: 0, misses: 1 });
  });

  it('degrades to a miss — without throwing — when the read rejects with `undefined`', async () => {
    // A bare `(err as Error).message` would throw reading `.message` off
    // `undefined`, escaping the catch and failing the request a cache is
    // supposed to only ever make faster, never break.
    cache.get.mockRejectedValue(undefined);
    await expect(subject.read('vrank', 'g', 'hosts', 'daily', '20260722', 1)).resolves.toBeNull();
    expect(subject.snapshotCounters()).toEqual({ hits: 0, misses: 1 });
  });

  it('swallows write failures — a cache miss must never fail a request', async () => {
    cache.set.mockRejectedValue(new Error('OOM'));
    await expect(
      subject.write('vrank', 'g', 'hosts', 'daily', '20260722', 1, [], 30),
    ).resolves.toBeUndefined();
    expect(subject.snapshotCounters()).toEqual({ hits: 0, misses: 0 });
  });

  it('swallows a write rejecting with `undefined` — without throwing', async () => {
    cache.set.mockRejectedValue(undefined);
    await expect(
      subject.write('vrank', 'g', 'hosts', 'daily', '20260722', 1, [], 30),
    ).resolves.toBeUndefined();
    expect(subject.snapshotCounters()).toEqual({ hits: 0, misses: 0 });
  });

  it('resets counters when snapshotted', () => {
    subject.snapshotCounters();
    expect(subject.snapshotCounters()).toEqual({ hits: 0, misses: 0 });
  });
});
