import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import {
  VIDEO_ROOM_PK_END_JOB,
  VIDEO_ROOM_PK_START_JOB,
} from '../constants/video-room-pk.constants';
import { VideoRoomPkTimerService } from './video-room-pk-timer.service';

const at = (iso: string) => new Date(iso);

/**
 * `QueueService` (src/infra/queue/queue.service.ts) exposes no `remove`
 * method — only `getQueue(name)`, which returns the real BullMQ `Queue`
 * instance. `cancelEnd` therefore goes through `getQueue(...).remove(jobId)`,
 * so the mock shape here mirrors that real API rather than inventing one.
 */
function mockQueueService() {
  const removedQueue = { remove: jest.fn().mockResolvedValue(1) };
  return {
    enqueueDelayed: jest.fn(),
    getQueue: jest.fn().mockReturnValue(removedQueue),
    __removedQueue: removedQueue,
  };
}

describe('VideoRoomPkTimerService', () => {
  it('schedules the end job with the resumeSeq in its id', async () => {
    const queue = mockQueueService();
    const svc = new VideoRoomPkTimerService(queue as never);

    await svc.scheduleEnd(
      {
        id: 'b1',
        roomId: 'r1',
        resumeSeq: 2,
        endsAt: at('2026-07-22T00:05:00Z'),
      } as never,
      at('2026-07-22T00:00:00Z'),
    );

    expect(queue.enqueueDelayed).toHaveBeenCalledWith(
      QUEUE_NAMES.GIFT_PROCESSING,
      VIDEO_ROOM_PK_END_JOB,
      { roomId: 'r1', battleId: 'b1', resumeSeq: 2 },
      300_000,
      expect.objectContaining({ jobId: 'pk-end:b1:2' }),
    );
  });

  it('embeds a DIFFERENT resumeSeq in the jobId when the battle has resumed again', async () => {
    // Guards against a hardcoded or stale resumeSeq defeating the whole guard.
    const queue = mockQueueService();
    const svc = new VideoRoomPkTimerService(queue as never);

    await svc.scheduleEnd(
      { id: 'b1', roomId: 'r1', resumeSeq: 7, endsAt: at('2026-07-22T00:05:00Z') } as never,
      at('2026-07-22T00:00:00Z'),
    );

    expect(queue.enqueueDelayed).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ resumeSeq: 7 }),
      expect.anything(),
      expect.objectContaining({ jobId: 'pk-end:b1:7' }),
    );
  });

  // The arithmetic that PAUSE exists for. 60s elapsed of a 300s battle, paused
  // for 120s, must still have 240s left — not 120s.
  it('pushes endsAt forward by exactly the paused duration', () => {
    const svc = new VideoRoomPkTimerService({} as never);
    const out = svc.computeResume(
      {
        id: 'b1',
        resumeSeq: 0,
        totalPausedMs: 0,
        endsAt: at('2026-07-22T00:05:00Z'),
        pausedAt: at('2026-07-22T00:01:00Z'),
      } as never,
      at('2026-07-22T00:03:00Z'),
    );

    expect(out.endsAt.toISOString()).toBe('2026-07-22T00:07:00.000Z');
    expect(out.totalPausedMs).toBe(120_000);
    expect(out.resumeSeq).toBe(1);
  });

  it('accumulates across repeated pauses', () => {
    const svc = new VideoRoomPkTimerService({} as never);
    const out = svc.computeResume(
      {
        id: 'b1',
        resumeSeq: 3,
        totalPausedMs: 45_000,
        endsAt: at('2026-07-22T00:05:00Z'),
        pausedAt: at('2026-07-22T00:02:00Z'),
      } as never,
      at('2026-07-22T00:02:30Z'),
    );
    expect(out.totalPausedMs).toBe(75_000);
    expect(out.resumeSeq).toBe(4);
  });

  it('computeResume tolerates a null pausedAt without producing NaN or an Invalid Date', () => {
    // A resume call that races an already-cleared pausedAt must not corrupt
    // endsAt/totalPausedMs; pausedFor degrades to 0 rather than NaN.
    const svc = new VideoRoomPkTimerService({} as never);
    const out = svc.computeResume(
      {
        id: 'b1',
        resumeSeq: 0,
        totalPausedMs: 10_000,
        endsAt: at('2026-07-22T00:05:00Z'),
        pausedAt: null,
      } as never,
      at('2026-07-22T00:03:00Z'),
    );

    expect(Number.isNaN(out.endsAt.getTime())).toBe(false);
    expect(out.endsAt.toISOString()).toBe('2026-07-22T00:05:00.000Z');
    expect(out.totalPausedMs).toBe(10_000);
    expect(out.resumeSeq).toBe(1);
  });

  it('never schedules a negative delay', async () => {
    const queue = mockQueueService();
    const svc = new VideoRoomPkTimerService(queue as never);

    await svc.scheduleEnd(
      { id: 'b1', roomId: 'r1', resumeSeq: 0, endsAt: at('2026-07-22T00:00:00Z') } as never,
      at('2026-07-22T00:10:00Z'),
    );

    expect(queue.enqueueDelayed).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      0,
      expect.anything(),
    );
  });

  it('remainingMs is 0 (not NaN) when endsAt is null', () => {
    const svc = new VideoRoomPkTimerService({} as never);
    const result = svc.remainingMs({ endsAt: null } as never, at('2026-07-22T00:10:00Z'));

    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(0);
  });

  it('removes the pending end job on pause, for the CURRENT resumeSeq', async () => {
    const queue = mockQueueService();
    await new VideoRoomPkTimerService(queue as never).cancelEnd({
      id: 'b1',
      resumeSeq: 1,
    } as never);

    expect(queue.getQueue).toHaveBeenCalledWith(QUEUE_NAMES.GIFT_PROCESSING);
    expect(queue.__removedQueue.remove).toHaveBeenCalledWith('pk-end:b1:1');
  });

  it('cancelEnd swallows a removal failure rather than throwing (best-effort; resumeSeq is the real guard)', async () => {
    const queue = {
      enqueueDelayed: jest.fn(),
      getQueue: jest.fn().mockReturnValue({
        remove: jest.fn().mockRejectedValue(new Error('redis blip')),
      }),
    };

    await expect(
      new VideoRoomPkTimerService(queue as never).cancelEnd({ id: 'b1', resumeSeq: 1 } as never),
    ).resolves.toBeUndefined();
  });

  it('schedules the countdown job keyed by battle id only (no resumeSeq: countdown can never be paused)', async () => {
    const queue = mockQueueService();
    const svc = new VideoRoomPkTimerService(queue as never);

    await svc.scheduleCountdown(
      { id: 'b1', roomId: 'r1', resumeSeq: 0, countdownSeconds: 10 } as never,
      at('2026-07-22T00:00:00Z'),
    );

    expect(queue.enqueueDelayed).toHaveBeenCalledWith(
      QUEUE_NAMES.GIFT_PROCESSING,
      VIDEO_ROOM_PK_START_JOB,
      { roomId: 'r1', battleId: 'b1', resumeSeq: 0 },
      10_000,
      expect.objectContaining({ jobId: 'pk-start:b1' }),
    );
  });
});
