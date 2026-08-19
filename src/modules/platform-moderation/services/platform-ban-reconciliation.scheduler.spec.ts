import { PlatformBanReconciliationScheduler } from './platform-ban-reconciliation.scheduler';

describe('PlatformBanReconciliationScheduler', () => {
  let repo: Record<string, jest.Mock>;
  let redis: Record<string, jest.Mock>;
  let scheduler: PlatformBanReconciliationScheduler;

  beforeEach(() => {
    repo = { listActive: jest.fn().mockResolvedValue([]) };
    redis = { set: jest.fn().mockResolvedValue('OK') };
    scheduler = new PlatformBanReconciliationScheduler(repo as never, redis as never);
  });

  it('re-primes the Redis key for every active, unexpired ban with its true remaining TTL — this is what heals a ban silently unenforced after a Redis restart/flush', async () => {
    repo.listActive.mockResolvedValue([
      {
        targetUserId: 'user-1',
        reason: 'harassment',
        expiresAt: new Date(Date.now() + 3600_000), // 1h left
      },
    ]);

    await scheduler.reconcile();

    expect(redis.set).toHaveBeenCalledWith(
      'platform-ban:user:user-1',
      expect.stringContaining('harassment'),
      'EX',
      expect.any(Number),
    );
    const ttl = redis.set.mock.calls[0][3];
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('skips a row whose expiry has already passed but was never explicitly lifted (no automatic EXPIRED sweep exists)', async () => {
    repo.listActive.mockResolvedValue([
      {
        targetUserId: 'user-2',
        reason: 'spam',
        expiresAt: new Date(Date.now() - 1000),
      },
    ]);

    await scheduler.reconcile();

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('re-primes every active ban independently, and one failure does not stop the rest', async () => {
    repo.listActive.mockResolvedValue([
      { targetUserId: 'user-3', reason: 'a', expiresAt: new Date(Date.now() + 3600_000) },
      { targetUserId: 'user-4', reason: 'b', expiresAt: new Date(Date.now() + 3600_000) },
    ]);
    // Keyed by the actual Redis key argument rather than call order, so this
    // doesn't depend on which of the two happens to run first.
    redis.set.mockImplementation((key: string) =>
      key.endsWith('user-3') ? Promise.reject(new Error('redis down')) : Promise.resolve('OK'),
    );

    await expect(scheduler.reconcile()).resolves.toBeUndefined();

    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledWith(
      'platform-ban:user:user-4',
      expect.any(String),
      'EX',
      expect.any(Number),
    );
  });

  it('does nothing when a Postgres lookup itself fails, rather than throwing out of the cron tick', async () => {
    repo.listActive.mockRejectedValueOnce(new Error('db down'));

    await expect(scheduler.reconcile()).resolves.toBeUndefined();
    expect(redis.set).not.toHaveBeenCalled();
  });
});
