import { spamCounterKey } from '../../constants/video-room-moderation.constants';
import type { ModerationDetectorConfig, ModerationSignal } from './moderation-detector.interface';
import { SpamDetector } from './spam.detector';

const CFG = { spamThreshold: 5, spamWindowSec: 60 } as ModerationDetectorConfig;

const messageSignal = (over: Partial<Extract<ModerationSignal, { type: 'message' }>> = {}) =>
  ({
    type: 'message',
    roomId: 'r1',
    userId: 'u1',
    contentHash: 'h1',
    spamFlagged: true,
    ...over,
  }) as ModerationSignal;

describe('SpamDetector', () => {
  let redis: { incr: jest.Mock; expire: jest.Mock };
  let detector: SpamDetector;

  beforeEach(() => {
    redis = { incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) };
    detector = new SpamDetector(redis as never);
  });

  it('is labelled "spam"', () => {
    expect(detector.kind).toBe('spam');
  });

  it('ignores non-message signals', async () => {
    await expect(
      detector.evaluate({ type: 'join_leave', roomId: 'r1', userId: 'u1' }, CFG),
    ).resolves.toBeNull();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('counts a flagged message exactly once via the spam counter (no re-scan)', async () => {
    await detector.evaluate(messageSignal(), CFG);
    expect(redis.incr).toHaveBeenCalledTimes(1);
    expect(redis.incr).toHaveBeenCalledWith(spamCounterKey('r1', 'u1'));
    // First increment arms the window TTL.
    expect(redis.expire).toHaveBeenCalledWith(spamCounterKey('r1', 'u1'), 60);
  });

  it('does NOT count (or re-scan) a message the chat layer did not flag', async () => {
    const result = await detector.evaluate(messageSignal({ spamFlagged: false }), CFG);
    expect(result).toBeNull();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('returns null while under threshold', async () => {
    redis.incr.mockResolvedValue(4);
    await expect(detector.evaluate(messageSignal(), CFG)).resolves.toBeNull();
  });

  it('recommends auto_mute once the flagged count reaches the threshold', async () => {
    redis.incr.mockResolvedValue(5);
    const result = await detector.evaluate(messageSignal(), CFG);
    expect(result).toMatchObject({ action: 'auto_mute' });
    expect(result?.reason).toContain('spam');
  });

  it('only arms the TTL on the first increment, not subsequent ones', async () => {
    redis.incr.mockResolvedValue(3);
    await detector.evaluate(messageSignal(), CFG);
    expect(redis.expire).not.toHaveBeenCalled();
  });
});
