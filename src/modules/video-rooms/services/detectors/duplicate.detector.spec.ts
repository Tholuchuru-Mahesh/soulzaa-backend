import { dupKey } from '../../constants/video-room-moderation.constants';
import type { ModerationDetectorConfig, ModerationSignal } from './moderation-detector.interface';
import { DuplicateDetector } from './duplicate.detector';

const CFG = { duplicateWindowSec: 30 } as ModerationDetectorConfig;

const messageSignal = (contentHash?: string): ModerationSignal => ({
  type: 'message',
  roomId: 'r1',
  userId: 'u1',
  contentHash,
  spamFlagged: false,
});

describe('DuplicateDetector', () => {
  let redis: { get: jest.Mock; set: jest.Mock };
  let detector: DuplicateDetector;

  beforeEach(() => {
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };
    detector = new DuplicateDetector(redis as never);
  });

  it('is labelled "duplicate"', () => {
    expect(detector.kind).toBe('duplicate');
  });

  it('ignores non-message signals', async () => {
    await expect(
      detector.evaluate({ type: 'join_leave', roomId: 'r1', userId: 'u1' }, CFG),
    ).resolves.toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('records the current hash with the dedup window and returns null on a first-seen hash', async () => {
    const result = await detector.evaluate(messageSignal('h1'), CFG);
    expect(result).toBeNull();
    expect(redis.set).toHaveBeenCalledWith(dupKey('r1', 'u1'), 'h1', 'PX', 30_000);
  });

  it('returns null when the previous hash differs (not a repeat)', async () => {
    redis.get.mockResolvedValue('other-hash');
    await expect(detector.evaluate(messageSignal('h1'), CFG)).resolves.toBeNull();
  });

  it('recommends auto_mute when the same hash recurs inside the window', async () => {
    redis.get.mockResolvedValue('h1');
    const result = await detector.evaluate(messageSignal('h1'), CFG);
    expect(result).toMatchObject({ action: 'auto_mute' });
    expect(result?.reason).toContain('duplicate');
  });

  it('skips detection when the signal carries no real content hash (e.g. a spam-kind proxy, not message content)', async () => {
    const result = await detector.evaluate(messageSignal(undefined), CFG);
    expect(result).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('does not treat two different spam-kind signals (no contentHash) as duplicates even when Redis holds a stale marker', async () => {
    // Even if a real content hash were previously recorded, an absent
    // contentHash on the current signal must never be compared against it.
    redis.get.mockResolvedValue('some-previous-hash');
    const result = await detector.evaluate(messageSignal(undefined), CFG);
    expect(result).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });
});
