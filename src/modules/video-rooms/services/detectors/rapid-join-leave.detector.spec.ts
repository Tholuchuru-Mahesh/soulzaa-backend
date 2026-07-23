import { joinLeaveKey } from '../../constants/video-room-moderation.constants';
import type { ModerationDetectorConfig, ModerationSignal } from './moderation-detector.interface';
import { RapidJoinLeaveDetector } from './rapid-join-leave.detector';

const CFG = {
  rapidJoinLeaveThreshold: 5,
  rapidJoinLeaveWindowSec: 60,
} as ModerationDetectorConfig;

const joinLeaveSignal = (): ModerationSignal => ({
  type: 'join_leave',
  roomId: 'r1',
  userId: 'u1',
});

describe('RapidJoinLeaveDetector', () => {
  let redis: { incr: jest.Mock; expire: jest.Mock };
  let detector: RapidJoinLeaveDetector;

  beforeEach(() => {
    redis = { incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) };
    detector = new RapidJoinLeaveDetector(redis as never);
  });

  it('is labelled "rapid-join-leave"', () => {
    expect(detector.kind).toBe('rapid-join-leave');
  });

  it('ignores non-join_leave signals', async () => {
    await expect(
      detector.evaluate(
        { type: 'message', roomId: 'r1', userId: 'u1', contentHash: 'h', spamFlagged: false },
        CFG,
      ),
    ).resolves.toBeNull();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('counts each join/leave transition on the windowed counter', async () => {
    await detector.evaluate(joinLeaveSignal(), CFG);
    expect(redis.incr).toHaveBeenCalledWith(joinLeaveKey('r1', 'u1'));
    expect(redis.expire).toHaveBeenCalledWith(joinLeaveKey('r1', 'u1'), 60);
  });

  it('returns null while under threshold', async () => {
    redis.incr.mockResolvedValue(4);
    await expect(detector.evaluate(joinLeaveSignal(), CFG)).resolves.toBeNull();
  });

  it('recommends auto_kick once the transitions reach the threshold', async () => {
    redis.incr.mockResolvedValue(5);
    const result = await detector.evaluate(joinLeaveSignal(), CFG);
    expect(result).toMatchObject({ action: 'auto_kick' });
    expect(result?.reason).toContain('join');
  });
});
