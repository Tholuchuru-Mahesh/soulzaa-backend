import { floodCounterKey } from '../../constants/video-room-moderation.constants';
import type { ModerationDetectorConfig, ModerationSignal } from './moderation-detector.interface';
import { FloodDetector } from './flood.detector';

const CFG = { floodThreshold: 10, floodWindowSec: 10 } as ModerationDetectorConfig;

const messageSignal = (over: Partial<Extract<ModerationSignal, { type: 'message' }>> = {}) =>
  ({
    type: 'message',
    roomId: 'r1',
    userId: 'u1',
    contentHash: 'h1',
    spamFlagged: false,
    ...over,
  }) as ModerationSignal;

describe('FloodDetector', () => {
  let redis: { incr: jest.Mock; expire: jest.Mock };
  let detector: FloodDetector;

  beforeEach(() => {
    redis = { incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) };
    detector = new FloodDetector(redis as never);
  });

  it('is labelled "flood"', () => {
    expect(detector.kind).toBe('flood');
  });

  it('ignores non-message signals', async () => {
    await expect(
      detector.evaluate({ type: 'report', roomId: 'r1', targetUserId: 'u2' }, CFG),
    ).resolves.toBeNull();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('counts EVERY message regardless of the spam verdict', async () => {
    await detector.evaluate(messageSignal({ spamFlagged: false }), CFG);
    expect(redis.incr).toHaveBeenCalledWith(floodCounterKey('r1', 'u1'));
    expect(redis.expire).toHaveBeenCalledWith(floodCounterKey('r1', 'u1'), 10);
  });

  it('returns null while under threshold', async () => {
    redis.incr.mockResolvedValue(9);
    await expect(detector.evaluate(messageSignal(), CFG)).resolves.toBeNull();
  });

  it('recommends auto_mute once the volume reaches the threshold', async () => {
    redis.incr.mockResolvedValue(10);
    const result = await detector.evaluate(messageSignal(), CFG);
    expect(result).toMatchObject({ action: 'auto_mute' });
    expect(result?.reason).toContain('flood');
  });
});
