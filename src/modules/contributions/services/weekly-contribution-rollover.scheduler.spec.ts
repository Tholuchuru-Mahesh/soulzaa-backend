import { currentIsoWeekKeyUtc } from 'src/common/utils/iso-week.util';
import type { IEventBus } from 'src/common/events';
import type { LockService } from 'src/infra/redis/lock.service';
import type { WeeklyContributionRepository } from '../repositories/weekly-contribution.repository';
import { WeeklyContributionRolloverScheduler } from './weekly-contribution-rollover.scheduler';

describe('WeeklyContributionRolloverScheduler', () => {
  let repo: jest.Mocked<
    Pick<WeeklyContributionRepository, 'liveRoomIds' | 'getWeekBucket' | 'roomLifetimeContribution'>
  >;
  let bus: jest.Mocked<Pick<IEventBus, 'publish'>>;
  let locks: jest.Mocked<Pick<LockService, 'withLock'>>;
  let scheduler: WeeklyContributionRolloverScheduler;

  beforeEach(() => {
    repo = {
      liveRoomIds: jest.fn().mockResolvedValue(['room-a', 'room-b']),
      getWeekBucket: jest.fn().mockImplementation(async (_s, id) => ({
        weekKey: currentIsoWeekKeyUtc(),
        weekStart: 's',
        weekEnd: 'e',
        amount: id === 'room-a' ? 0 : 250,
      })),
      roomLifetimeContribution: jest.fn().mockResolvedValue(999_999),
    } as never;
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    locks = { withLock: jest.fn((_k, fn: () => unknown) => fn()) } as never;

    scheduler = new WeeklyContributionRolloverScheduler(
      repo as unknown as WeeklyContributionRepository,
      locks as unknown as LockService,
      bus as unknown as IEventBus,
    );
  });

  it('pushes one week_rollover event per live room with the current week figure', async () => {
    const res = await scheduler.run();

    expect(res.rooms).toBe(2);
    expect(res.weekKey).toBe(currentIsoWeekKeyUtc());
    expect(bus.publish).toHaveBeenCalledTimes(2);

    const payloads = bus.publish.mock.calls.map((c) => (c[0] as { payload: any }).payload);
    for (const p of payloads) {
      expect(p.reason).toBe('week_rollover');
      expect(p.receiverId).toBeNull();
      expect(p.weekKey).toBe(currentIsoWeekKeyUtc());
      expect(p.roomTotal).toBe(999_999); // lifetime preserved in the payload
    }
    expect(payloads.find((p) => p.roomId === 'room-a')!.roomWeekTotal).toBe(0);
    expect(payloads.find((p) => p.roomId === 'room-b')!.roomWeekTotal).toBe(250);
  });

  it('does nothing when there are no live rooms', async () => {
    repo.liveRoomIds.mockResolvedValue([]);
    const res = await scheduler.run();
    expect(res.rooms).toBe(0);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('the cron entrypoint runs under a lock and swallows failures', async () => {
    locks.withLock.mockRejectedValueOnce(new Error('lock held elsewhere'));
    await expect(scheduler.broadcastRollover()).resolves.toBeUndefined();
  });
});
