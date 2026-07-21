import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomChatRateLimiter } from './video-room-chat-rate-limiter.service';

const CFG = {
  rateWindowSeconds: 60,
  dedupWindowSeconds: 30,
  floodBurstMax: 5,
  floodBurstWindowSeconds: 2,
  cooldownSteps: [10, 30, 120],
};

const OPTS = { rateMax: 20, slowModeSeconds: 0 };

describe('VideoRoomChatRateLimiter', () => {
  let cache: { increment: jest.Mock; exists: jest.Mock };
  let redis: { set: jest.Mock };
  let config: { get: jest.Mock };
  let limiter: VideoRoomChatRateLimiter;

  beforeEach(() => {
    cache = {
      increment: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(false),
    };
    redis = { set: jest.fn().mockResolvedValue('OK') };
    config = { get: jest.fn().mockReturnValue(CFG) };
    limiter = new VideoRoomChatRateLimiter(cache as never, redis as never, config as never);
  });

  it('allows a message inside every limit', async () => {
    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).resolves.toBeUndefined();
  });

  it('rejects when an active cooldown is present', async () => {
    cache.exists.mockImplementation((key: string) => Promise.resolve(key.includes(':cd:')));

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toMatchObject({
      errorCode: ERROR_CODES.CHAT_RATE_LIMITED,
    });
  });

  it('rejects when the per-minute rate cap is exceeded', async () => {
    cache.increment.mockImplementation((key: string) =>
      Promise.resolve(key.includes(':rate:') ? 21 : 1),
    );

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toMatchObject({
      errorCode: ERROR_CODES.CHAT_RATE_LIMITED,
    });
  });

  it('rejects while slow mode is active', async () => {
    cache.exists.mockImplementation((key: string) => Promise.resolve(key.includes(':slow:')));

    await expect(
      limiter.assertMaySend('r1', 'u1', 'hello', { rateMax: 20, slowModeSeconds: 10 }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.CHAT_SLOW_MODE });
  });

  it('rejects a burst and arms an escalating cooldown', async () => {
    cache.increment.mockImplementation((key: string) => {
      if (key.includes(':flood:')) return Promise.resolve(6);
      if (key.includes(':viol:')) return Promise.resolve(2);
      return Promise.resolve(1);
    });

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toMatchObject({
      errorCode: ERROR_CODES.CHAT_RATE_LIMITED,
    });
    // Second violation → the second rung of the ladder (30s), not the first.
    expect(redis.set).toHaveBeenCalledWith('video-room:{r1}:chat:cd:u1', '1', 'EX', 30);
  });

  it('caps the cooldown ladder at its last rung', async () => {
    cache.increment.mockImplementation((key: string) => {
      if (key.includes(':flood:')) return Promise.resolve(6);
      if (key.includes(':viol:')) return Promise.resolve(99);
      return Promise.resolve(1);
    });

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toBeDefined();
    expect(redis.set).toHaveBeenCalledWith('video-room:{r1}:chat:cd:u1', '1', 'EX', 120);
  });

  it('rejects a duplicate message inside the window', async () => {
    // SET NX returns null when the key already exists ⇒ duplicate.
    redis.set.mockImplementation((key: string) =>
      Promise.resolve(key.includes(':dedup:') ? null : 'OK'),
    );

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toMatchObject({
      errorCode: ERROR_CODES.DUPLICATE_MESSAGE,
    });
  });

  it('hashes content case-insensitively so casing tricks still dedupe', async () => {
    await limiter.assertMaySend('r1', 'u1', 'Hello', OPTS);
    const firstKey = redis.set.mock.calls.find((c) => String(c[0]).includes(':dedup:'))![0];

    redis.set.mockClear();
    await limiter.assertMaySend('r1', 'u1', 'hello', OPTS);
    const secondKey = redis.set.mock.calls.find((c) => String(c[0]).includes(':dedup:'))![0];

    expect(firstKey).toBe(secondKey);
  });
});
