import { VideoRoomTreasureRecoveryService } from './video-room-treasure-recovery.service';

const NOW = 1_700_000_000_000;
const orphan = (id: string) => ({
  id,
  sessionId: 's1',
  roomId: 'r1',
  level: 1,
  status: 'UNLOCKING',
});

describe('VideoRoomTreasureRecoveryService', () => {
  let repo: { findOrphanedBoxes: jest.Mock };
  let rewards: { getPool: jest.Mock };
  let unlock: { handle: jest.Mock };
  let locks: { withLock: jest.Mock };
  let bus: { publish: jest.Mock };
  let queue: { getDeadLetterJobs: jest.Mock; replayDeadLetter: jest.Mock };
  let metrics: { setTreasureQueueDepth: jest.Mock };

  const cfg = (over: Record<string, unknown> = {}) =>
    ({
      get: () => ({
        recoveryEnabled: 'true',
        orphanTimeoutSeconds: '120',
        monitorIntervalSeconds: '30',
        ...over,
      }),
    }) as never;

  const build = (config = cfg()) =>
    new VideoRoomTreasureRecoveryService(
      repo as never,
      rewards as never,
      unlock as never,
      locks as never,
      bus as never,
      config,
      queue as never,
      metrics as never,
      () => NOW,
    );

  beforeEach(() => {
    repo = { findOrphanedBoxes: jest.fn().mockResolvedValue([]) };
    rewards = { getPool: jest.fn().mockResolvedValue(null) };
    unlock = {
      handle: jest.fn().mockResolvedValue({ replayed: false, winners: 3, poolAmount: 1500 }),
    };
    locks = { withLock: jest.fn((_k: string, fn: () => unknown) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    queue = {
      getDeadLetterJobs: jest.fn().mockResolvedValue([]),
      replayDeadLetter: jest.fn().mockResolvedValue({ id: 'new' }),
    };
    metrics = { setTreasureQueueDepth: jest.fn() };
  });

  it('does nothing when recovery is disabled', async () => {
    const service = build(cfg({ recoveryEnabled: 'false' }));
    expect(await service.sweep()).toEqual({ reclaimed: 0, skipped: 0, replayed: 0 });
    expect(repo.findOrphanedBoxes).not.toHaveBeenCalled();
  });

  it('does not start a timer when recovery is disabled', () => {
    const service = build(cfg({ recoveryEnabled: 'false' }));
    service.onModuleInit();
    service.onModuleDestroy();
    expect(repo.findOrphanedBoxes).not.toHaveBeenCalled();
  });

  it('looks back exactly the configured orphan timeout', async () => {
    await build().sweep();
    expect(repo.findOrphanedBoxes).toHaveBeenCalledWith(
      new Date(NOW - 120_000),
      expect.any(Number),
    );
  });

  it('re-runs an orphaned box that never minted a pool', async () => {
    repo.findOrphanedBoxes.mockResolvedValue([orphan('b1')]);
    const res = await build().sweep();
    expect(unlock.handle).toHaveBeenCalledWith(
      expect.objectContaining({ boxId: 'b1', roomId: 'r1', level: 1 }),
      1,
    );
    expect(res.reclaimed).toBe(1);
  });

  // A pool row proves the unlock already committed; the box is UNLOCKING only
  // because the process died after commit.
  it('skips an orphan that already has a pool row', async () => {
    repo.findOrphanedBoxes.mockResolvedValue([orphan('b1')]);
    rewards.getPool.mockResolvedValue({ id: 'p1' });
    const res = await build().sweep();
    expect(unlock.handle).not.toHaveBeenCalled();
    expect(res).toEqual({ reclaimed: 0, skipped: 1, replayed: 0 });
  });

  it('publishes TreasureRecovered with the ORPHAN_RECLAIM reason', async () => {
    repo.findOrphanedBoxes.mockResolvedValue([orphan('b1')]);
    await build().sweep();
    const evt = bus.publish.mock.calls[0][0] as {
      name: string;
      payload: { reason: string; correlationId: string };
    };
    expect(evt.name).toBe('video_room.treasure.recovered');
    expect(evt.payload.reason).toBe('ORPHAN_RECLAIM');
    expect(evt.payload.correlationId).toBe('recovery:b1');
  });

  // One poisoned box must not stop the sweep reclaiming the rest.
  it('continues past a box whose re-run throws', async () => {
    repo.findOrphanedBoxes.mockResolvedValue([orphan('b1'), orphan('b2')]);
    unlock.handle.mockRejectedValueOnce(new Error('still broken'));
    const res = await build().sweep();
    expect(unlock.handle).toHaveBeenCalledTimes(2);
    expect(res.reclaimed).toBe(1);
  });

  it('serialises the sweep fleet-wide so two pods cannot both reclaim', async () => {
    await build().sweep();
    expect(locks.withLock).toHaveBeenCalledWith(
      'video-room:treasure:recovery',
      expect.any(Function),
    );
  });

  describe('dead-letter replay', () => {
    const dlqJob = (id: string, name: string) => ({
      id,
      data: { name, data: { roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1 } },
    });

    it('replays a dead-lettered treasure unlock', async () => {
      queue.getDeadLetterJobs.mockResolvedValue([dlqJob('d1', 'video-room.treasure.unlock')]);
      const res = await build().sweep();
      expect(queue.replayDeadLetter).toHaveBeenCalledWith('d1');
      expect(res.replayed).toBe(1);
    });

    // The DLQ is shared with gifts; a treasure sweep must not replay their jobs.
    it('ignores dead letters belonging to another job type', async () => {
      queue.getDeadLetterJobs.mockResolvedValue([dlqJob('d1', 'video-room.gift.deliver')]);
      const res = await build().sweep();
      expect(queue.replayDeadLetter).not.toHaveBeenCalled();
      expect(res.replayed).toBe(0);
    });

    it('publishes TreasureRecovered with the DLQ_REPLAY reason', async () => {
      queue.getDeadLetterJobs.mockResolvedValue([dlqJob('d1', 'video-room.treasure.unlock')]);
      await build().sweep();
      const evt = bus.publish.mock.calls[0][0] as { payload: { reason: string } };
      expect(evt.payload.reason).toBe('DLQ_REPLAY');
    });

    // Depth is an operational signal that must exist even with automatic
    // replay switched off, so it is reported by the tick, not the sweep — and
    // counts only treasure jobs off the shared queue.
    it('reports treasure dead-letter depth on every tick, even when recovery is disabled', async () => {
      queue.getDeadLetterJobs.mockResolvedValue([
        dlqJob('d1', 'video-room.treasure.unlock'),
        dlqJob('d2', 'video-room.gift.deliver'),
      ]);
      const service = build(cfg({ recoveryEnabled: 'false' }));
      await service.tick();
      expect(metrics.setTreasureQueueDepth).toHaveBeenCalledWith(1);
      expect(queue.replayDeadLetter).not.toHaveBeenCalled();
    });

    it('still ticks when the DLQ read fails', async () => {
      queue.getDeadLetterJobs.mockRejectedValue(new Error('redis down'));
      await expect(build().tick()).resolves.toBeUndefined();
    });

    it('continues the orphan sweep when the DLQ is unreadable', async () => {
      queue.getDeadLetterJobs.mockRejectedValue(new Error('redis down'));
      repo.findOrphanedBoxes.mockResolvedValue([orphan('b1')]);
      const res = await build().sweep();
      expect(res).toEqual({ reclaimed: 1, skipped: 0, replayed: 0 });
    });

    it('continues past a job that cannot be replayed', async () => {
      queue.getDeadLetterJobs.mockResolvedValue([
        dlqJob('d1', 'video-room.treasure.unlock'),
        dlqJob('d2', 'video-room.treasure.unlock'),
      ]);
      queue.replayDeadLetter.mockRejectedValueOnce(new Error('gone'));
      expect((await build().sweep()).replayed).toBe(1);
    });
  });

  it('caps how many orphans one sweep attempts', async () => {
    await build().sweep();
    expect(repo.findOrphanedBoxes.mock.calls[0][1]).toBeLessThanOrEqual(50);
  });
});
