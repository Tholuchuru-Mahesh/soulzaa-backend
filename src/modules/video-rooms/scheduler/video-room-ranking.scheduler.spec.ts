import { VIDEO_ROOM_RANKING_JOBS } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingScheduler } from './video-room-ranking.scheduler';

describe('VideoRoomRankingScheduler', () => {
  let queue: { schedule: jest.Mock };
  let scheduler: VideoRoomRankingScheduler;

  beforeEach(() => {
    queue = { schedule: jest.fn().mockResolvedValue({}) };
    scheduler = new VideoRoomRankingScheduler(queue as never);
  });

  it('schedules all seven repeatable jobs on the ranking queue', async () => {
    await scheduler.onModuleInit();
    expect(queue.schedule).toHaveBeenCalledTimes(7);
    const names = queue.schedule.mock.calls.map((c) => c[1]);
    expect(names.sort()).toEqual(Object.values(VIDEO_ROOM_RANKING_JOBS).sort());
    expect(queue.schedule.mock.calls.every((c) => c[0] === 'ranking-processing')).toBe(true);
  });

  it('gives every job a stable jobId so restarts do not duplicate schedules', async () => {
    await scheduler.onModuleInit();
    const ids = queue.schedule.mock.calls.map((c) => c[4]?.jobId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(7);
  });

  it('offsets each cron so aggregations do not all fire at midnight', async () => {
    await scheduler.onModuleInit();
    const patterns = queue.schedule.mock.calls.map((c) => c[3].pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it('logs and continues when scheduling fails — a boot must not be blocked', async () => {
    queue.schedule.mockRejectedValue(new Error('redis down'));
    await expect(scheduler.onModuleInit()).resolves.toBeUndefined();
  });

  it('isolates one failed schedule call — the other six jobs are still registered and boot proceeds', async () => {
    let call = 0;
    queue.schedule.mockImplementation(() => {
      call += 1;
      // Fail only the 3rd of the seven calls; the rest must still be attempted.
      if (call === 3) {
        return Promise.reject(new Error('redis down'));
      }
      return Promise.resolve({});
    });

    await expect(scheduler.onModuleInit()).resolves.toBeUndefined();
    expect(queue.schedule).toHaveBeenCalledTimes(7);
    const names = queue.schedule.mock.calls.map((c) => c[1]);
    expect(names.sort()).toEqual(Object.values(VIDEO_ROOM_RANKING_JOBS).sort());
  });
});
