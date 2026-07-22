import { VideoRoomPkStatus } from '@prisma/client';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import {
  VIDEO_ROOM_PK_END_JOB,
  VIDEO_ROOM_PK_START_JOB,
} from '../constants/video-room-pk.constants';
import { PKCountdownException } from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkJobsService } from './video-room-pk-jobs.service';

describe('VideoRoomPkJobsService', () => {
  let repo: { getBattle: jest.Mock };
  let state: { transition: jest.Mock };
  let timer: { scheduleEnd: jest.Mock };
  let settlement: { settle: jest.Mock };
  let registry: { register: jest.Mock };

  const build = (reg: { register: jest.Mock } = registry) =>
    new VideoRoomPkJobsService(
      reg as never,
      repo as never,
      state as never,
      timer as never,
      settlement as never,
    );

  beforeEach(() => {
    repo = { getBattle: jest.fn() };
    state = {
      transition: jest
        .fn()
        .mockImplementation((id: string, _from: unknown, to: VideoRoomPkStatus) =>
          Promise.resolve({ id, status: to, endsAt: new Date('2026-07-22T00:05:00Z') }),
        ),
    };
    timer = { scheduleEnd: jest.fn().mockResolvedValue(undefined) };
    settlement = { settle: jest.fn().mockResolvedValue(undefined) };
    registry = { register: jest.fn() };
  });

  it('registers both job names on the gift queue', () => {
    const registry = { register: jest.fn() };
    build(registry).onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(
      QUEUE_NAMES.GIFT_PROCESSING,
      VIDEO_ROOM_PK_START_JOB,
      expect.any(Function),
    );
    expect(registry.register).toHaveBeenCalledWith(
      QUEUE_NAMES.GIFT_PROCESSING,
      VIDEO_ROOM_PK_END_JOB,
      expect.any(Function),
    );
  });

  it('handleStart moves COUNTDOWN → LIVE and schedules the end job', async () => {
    repo.getBattle.mockResolvedValue({ id: 'b1', status: 'COUNTDOWN', resumeSeq: 0 });
    await build().handleStart({ roomId: 'r1', battleId: 'b1', resumeSeq: 0 });
    expect(state.transition).toHaveBeenCalledWith(
      'b1',
      VideoRoomPkStatus.COUNTDOWN,
      VideoRoomPkStatus.LIVE,
      expect.anything(),
    );
    expect(timer.scheduleEnd).toHaveBeenCalled();
  });

  // THE stale-job test. A job scheduled before a pause carries the old sequence;
  // running it would settle the battle early, mid-pause.
  it('handleEnd ignores a job whose resumeSeq is stale', async () => {
    repo.getBattle.mockResolvedValue({ id: 'b1', status: 'LIVE', resumeSeq: 3 });
    await build().handleEnd({ roomId: 'r1', battleId: 'b1', resumeSeq: 1 });
    expect(settlement.settle).not.toHaveBeenCalled();
  });

  it('handleEnd settles when the resumeSeq matches', async () => {
    repo.getBattle.mockResolvedValue({ id: 'b1', status: 'LIVE', resumeSeq: 3 });
    await build().handleEnd({ roomId: 'r1', battleId: 'b1', resumeSeq: 3 });
    expect(settlement.settle).toHaveBeenCalledWith('b1', 'timer');
  });

  it('handleEnd is a no-op for a battle that no longer exists', async () => {
    repo.getBattle.mockResolvedValue(null);
    await expect(
      build().handleEnd({ roomId: 'r1', battleId: 'gone', resumeSeq: 0 }),
    ).resolves.toBeUndefined();
    expect(settlement.settle).not.toHaveBeenCalled();
  });

  // ---- Extra coverage beyond the brief's 5 tests ----

  it('handleStart does not force LIVE on a battle that is not in COUNTDOWN', async () => {
    repo.getBattle.mockResolvedValue({ id: 'b1', status: 'LIVE', resumeSeq: 0 });
    await build().handleStart({ roomId: 'r1', battleId: 'b1', resumeSeq: 0 });
    expect(state.transition).not.toHaveBeenCalled();
    expect(timer.scheduleEnd).not.toHaveBeenCalled();
  });

  it('handleStart is a no-op for a battle that no longer exists', async () => {
    repo.getBattle.mockResolvedValue(null);
    await expect(
      build().handleStart({ roomId: 'r1', battleId: 'gone', resumeSeq: 0 }),
    ).resolves.toBeUndefined();
    expect(state.transition).not.toHaveBeenCalled();
  });

  it('handleEnd does not re-settle a battle that is already terminal', async () => {
    repo.getBattle.mockResolvedValue({
      id: 'b1',
      status: VideoRoomPkStatus.COMPLETED,
      resumeSeq: 3,
    });
    await build().handleEnd({ roomId: 'r1', battleId: 'b1', resumeSeq: 3 });
    expect(settlement.settle).not.toHaveBeenCalled();
  });

  // Wiring-gate closure: PKCountdownException was bound to a real error code
  // but never thrown. A race lost between this handler's own read (which
  // saw COUNTDOWN) and the CAS attempt (someone else moved the battle first)
  // must surface as this specific, distinguishable exception rather than the
  // generic PKBattleException the state service raises.
  it('throws PKCountdownException when the CAS to LIVE loses a race after its own read saw COUNTDOWN', async () => {
    repo.getBattle.mockResolvedValue({ id: 'b1', status: 'COUNTDOWN', resumeSeq: 0 });
    state.transition.mockRejectedValue(new Error('The PK battle is no longer COUNTDOWN'));

    await expect(
      build().handleStart({ roomId: 'r1', battleId: 'b1', resumeSeq: 0 }),
    ).rejects.toBeInstanceOf(PKCountdownException);
    expect(timer.scheduleEnd).not.toHaveBeenCalled();
  });

  it('handleEnd does not throw on a stale-seq job', async () => {
    repo.getBattle.mockResolvedValue({ id: 'b1', status: 'LIVE', resumeSeq: 3 });
    await expect(
      build().handleEnd({ roomId: 'r1', battleId: 'b1', resumeSeq: 1 }),
    ).resolves.toBeUndefined();
    expect(settlement.settle).not.toHaveBeenCalled();
  });
});
