import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VideoRoomChatRateLimiter } from './video-room-chat-rate-limiter.service';

const CFG = {
  rateWindowSeconds: 60,
  dedupWindowSeconds: 30,
  floodBurstMax: 5,
  floodBurstWindowSeconds: 2,
  cooldownSteps: [10, 30, 120],
};

const OPTS = { rateMax: 20, slowModeSeconds: 0 };

/** The `kind` of every SPAM_DETECTED event published during a call. */
const spamKinds = (bus: { publish: jest.Mock }) =>
  bus.publish.mock.calls
    .map(([event]: [{ name: string; payload: { kind: string } }]) => event)
    .filter((e) => e.name === VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED)
    .map((e) => e.payload.kind);

describe('VideoRoomChatRateLimiter', () => {
  let cache: { increment: jest.Mock; exists: jest.Mock };
  let redis: { set: jest.Mock };
  let config: { get: jest.Mock };
  let bus: { publish: jest.Mock };
  let limiter: VideoRoomChatRateLimiter;

  beforeEach(() => {
    cache = {
      increment: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(false),
    };
    redis = { set: jest.fn().mockResolvedValue('OK') };
    config = { get: jest.fn().mockReturnValue(CFG) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    limiter = new VideoRoomChatRateLimiter(
      cache as never,
      redis as never,
      config as never,
      bus as never,
    );
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

  it('publishes a cooldown spam signal when a cooldown is active', async () => {
    cache.exists.mockImplementation((key: string) => Promise.resolve(key.includes(':cd:')));

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toBeDefined();
    expect(spamKinds(bus)).toEqual(['cooldown']);
  });

  it('publishes a rate spam signal when the per-minute cap is exceeded', async () => {
    cache.increment.mockImplementation((key: string) =>
      Promise.resolve(key.includes(':rate:') ? 21 : 1),
    );

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toBeDefined();
    expect(spamKinds(bus)).toEqual(['rate']);
  });

  it('publishes a flood spam signal on a burst', async () => {
    cache.increment.mockImplementation((key: string) => {
      if (key.includes(':flood:')) return Promise.resolve(6);
      if (key.includes(':viol:')) return Promise.resolve(1);
      return Promise.resolve(1);
    });

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toBeDefined();
    expect(spamKinds(bus)).toEqual(['flood']);
  });

  it('publishes a duplicate spam signal on a repeated message', async () => {
    redis.set.mockImplementation((key: string) =>
      Promise.resolve(key.includes(':dedup:') ? null : 'OK'),
    );

    await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toBeDefined();
    expect(spamKinds(bus)).toEqual(['duplicate']);
  });

  // THE LOAD-BEARING NEGATIVE TEST. Slow mode is a room UX setting; a user hitting
  // it is COMPLYING with room policy, not abusing it. Counting it as spam would
  // flood the abuse dashboard with legitimate traffic.
  it('publishes NO spam signal when slow mode rejects the message', async () => {
    cache.exists.mockImplementation((key: string) => Promise.resolve(key.includes(':slow:')));

    await expect(
      limiter.assertMaySend('r1', 'u1', 'hello', { rateMax: 20, slowModeSeconds: 10 }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.CHAT_SLOW_MODE });
    expect(spamKinds(bus)).toEqual([]);
  });

  it('publishes nothing when the message passes every gate', async () => {
    await limiter.assertMaySend('r1', 'u1', 'hello', OPTS);
    expect(spamKinds(bus)).toEqual([]);
  });
});
