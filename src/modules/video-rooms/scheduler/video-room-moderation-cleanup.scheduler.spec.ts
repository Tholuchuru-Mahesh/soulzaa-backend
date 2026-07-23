import type { ConfigService } from '@nestjs/config';
import {
  MODERATION_CLEANUP_JOB,
  VideoRoomModerationCleanupScheduler,
} from './video-room-moderation-cleanup.scheduler';

function configMock(expiryMonitorIntervalMs: number | undefined = 15_000): ConfigService {
  return {
    get: jest.fn().mockReturnValue({ moderation: { expiryMonitorIntervalMs } }),
  } as unknown as ConfigService;
}

describe('VideoRoomModerationCleanupScheduler', () => {
  let queue: { add: jest.Mock };

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue({}) };
  });

  it('registers exactly one repeatable cleanup job on the CLEANUP queue on init', async () => {
    const scheduler = new VideoRoomModerationCleanupScheduler(queue as never, configMock());

    await scheduler.onModuleInit();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe(MODERATION_CLEANUP_JOB);
    expect(data).toEqual({});
    expect(opts).toMatchObject({ repeat: { every: 15_000 } });
  });

  it('reads the interval from videoRoom.moderation.expiryMonitorIntervalMs config (no hardcoding)', async () => {
    const scheduler = new VideoRoomModerationCleanupScheduler(queue as never, configMock(45_000));

    await scheduler.onModuleInit();

    const [, , opts] = queue.add.mock.calls[0];
    expect(opts.repeat).toEqual({ every: 45_000 });
  });

  it('gives the job a stable jobId so restarts/multiple instances do not duplicate the schedule', async () => {
    const scheduler = new VideoRoomModerationCleanupScheduler(queue as never, configMock());

    await scheduler.onModuleInit();

    const [, , opts] = queue.add.mock.calls[0];
    expect(opts.jobId).toBeTruthy();
  });

  it('throws when the moderation config namespace is not registered', async () => {
    const badConfig = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const scheduler = new VideoRoomModerationCleanupScheduler(queue as never, badConfig);

    await expect(scheduler.onModuleInit()).rejects.toThrow(
      /videoRoom.moderation.expiryMonitorIntervalMs config is not registered/,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });
});
