import { VIDEO_ROOM_GIFT_EVENTS } from '../events/video-room-gift.events';
import { VideoRoomGiftMonitor } from './video-room-gift.monitor';

const giftJob = (id: string, roomId = 'r1') => ({
  id,
  data: { name: 'video-room.gift.deliver', data: { roomId, batchId: `b-${id}` } },
});

describe('VideoRoomGiftMonitor', () => {
  let locks: { withLock: jest.Mock };
  let combo: { sweepExpired: jest.Mock };
  let queue: { getDeadLetterJobs: jest.Mock; replayDeadLetter: jest.Mock };
  let bus: { publish: jest.Mock };
  let metrics: { incGiftRecovery: jest.Mock };
  let config: { get: jest.Mock };

  const build = (recoveryEnabled = 'false') => {
    config.get.mockReturnValue({
      maxReceivers: 9,
      allowRoomAll: 'false',
      allowViewerGiftsDefault: 'true',
      recentFeedSize: 50,
      monitorIntervalSeconds: 15,
      recoveryEnabled,
    });
    return new VideoRoomGiftMonitor(
      locks as never,
      combo as never,
      queue as never,
      bus as never,
      metrics as never,
      config as never,
    );
  };

  beforeEach(() => {
    locks = { withLock: jest.fn().mockImplementation((_key, cb) => cb()) };
    combo = { sweepExpired: jest.fn().mockResolvedValue(0) };
    queue = {
      getDeadLetterJobs: jest.fn().mockResolvedValue([]),
      replayDeadLetter: jest.fn().mockResolvedValue({ id: 'new-job' }),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    metrics = { incGiftRecovery: jest.fn() };
    config = { get: jest.fn() };
  });

  it('guards the tick with the monitor lock', async () => {
    await build().tick();
    expect(locks.withLock.mock.calls[0][0]).toBe('video-room:gift:monitor');
  });

  it('sweeps expired combos on every tick', async () => {
    combo.sweepExpired.mockResolvedValue(3);
    await expect(build().tick()).resolves.toMatchObject({ combosClosed: 3 });
  });

  it('keeps sweeping when the combo sweep throws', async () => {
    combo.sweepExpired.mockRejectedValue(new Error('redis down'));
    await expect(build().tick()).resolves.toMatchObject({ combosClosed: 0 });
  });

  describe('dead-letter replay', () => {
    it('does NOT replay while recovery is disabled', async () => {
      queue.getDeadLetterJobs.mockResolvedValue([giftJob('d1')]);
      await build('false').tick();
      expect(queue.getDeadLetterJobs).not.toHaveBeenCalled();
      expect(queue.replayDeadLetter).not.toHaveBeenCalled();
    });

    it('replays only video-room gift jobs, never other queues work', async () => {
      queue.getDeadLetterJobs.mockResolvedValue([
        giftJob('d1'),
        { id: 'd2', data: { name: 'gift.sent', data: {} } },
        { id: 'd3', data: { name: 'notifications.push', data: {} } },
      ]);
      const result = await build('true').tick();
      expect(queue.replayDeadLetter).toHaveBeenCalledTimes(1);
      expect(queue.replayDeadLetter).toHaveBeenCalledWith('d1');
      expect(result.jobsReplayed).toBe(1);
    });

    it('publishes GiftRecovered carrying the replayed job id', async () => {
      queue.getDeadLetterJobs.mockResolvedValue([giftJob('d1')]);
      await build('true').tick();
      const event = bus.publish.mock.calls[0][0];
      expect(event.name).toBe(VIDEO_ROOM_GIFT_EVENTS.RECOVERED);
      expect(event.payload).toEqual({ batchId: 'b-d1', roomId: 'r1', jobId: 'd1' });
    });

    it('counts recovery outcomes for monitoring', async () => {
      queue.getDeadLetterJobs.mockResolvedValue([giftJob('d1'), giftJob('d2')]);
      queue.replayDeadLetter.mockRejectedValueOnce(new Error('gone'));
      await build('true').tick();
      expect(metrics.incGiftRecovery).toHaveBeenCalledWith('failure');
      expect(metrics.incGiftRecovery).toHaveBeenCalledWith('success');
    });

    it('continues past a job that fails to replay', async () => {
      queue.getDeadLetterJobs.mockResolvedValue([giftJob('d1'), giftJob('d2')]);
      queue.replayDeadLetter.mockRejectedValueOnce(new Error('gone'));
      const result = await build('true').tick();
      expect(result.jobsReplayed).toBe(1);
      expect(queue.replayDeadLetter).toHaveBeenCalledTimes(2);
    });

    it('survives a dead-letter queue read failure', async () => {
      queue.getDeadLetterJobs.mockRejectedValue(new Error('redis down'));
      await expect(build('true').tick()).resolves.toMatchObject({ jobsReplayed: 0 });
    });
  });

  it('skips a tick that overlaps a still-running one', async () => {
    let release!: () => void;
    locks.withLock.mockImplementation(
      async (_key, cb) =>
        new Promise((resolve) => {
          release = () => resolve(cb());
        }),
    );
    const monitor = build();
    const first = monitor.tick();
    const second = await monitor.tick();
    expect(second).toEqual({ combosClosed: 0, jobsReplayed: 0 });
    release();
    await first;
  });

  it('unrefs its timer so it never holds the process open', () => {
    const monitor = build();
    monitor.onModuleInit();
    monitor.onModuleDestroy();
    expect(true).toBe(true);
  });
});
