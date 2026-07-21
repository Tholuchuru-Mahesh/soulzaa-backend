import { VideoRoomChatCacheService } from './video-room-chat-cache.service';

const CFG = { recentBufferSize: 3, recentBufferTtlSeconds: 3600 };

function message(id: string) {
  return {
    roomId: 'r1',
    messageId: id,
    senderId: 'u1',
    type: 'TEXT',
    content: 'hi',
    mentions: [],
    mentionScope: null,
    replyToId: null,
    createdAt: '2026-07-21T00:00:00.000Z',
  };
}

describe('VideoRoomChatCacheService', () => {
  let redis: Record<string, jest.Mock>;
  let config: { get: jest.Mock };
  let service: VideoRoomChatCacheService;

  beforeEach(() => {
    redis = {
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
      expire: jest.fn().mockResolvedValue(1),
      lrange: jest.fn().mockResolvedValue([]),
      del: jest.fn().mockResolvedValue(1),
      sadd: jest.fn().mockResolvedValue(1),
      smembers: jest.fn().mockResolvedValue([]),
      zadd: jest.fn().mockResolvedValue(1),
      zrem: jest.fn().mockResolvedValue(1),
      zrangebyscore: jest.fn().mockResolvedValue([]),
      zremrangebyscore: jest.fn().mockResolvedValue(0),
    };
    config = { get: jest.fn().mockReturnValue(CFG) };
    service = new VideoRoomChatCacheService(redis as never, config as never);
  });

  it('trims the ring buffer to the configured size', async () => {
    await service.pushRecent('r1', message('m1'));

    expect(redis.lpush).toHaveBeenCalledWith(
      'video-room:{r1}:chat:recent',
      JSON.stringify(message('m1')),
    );
    // LTRIM keeps indices 0..size-1 — a 3-message buffer keeps 0..2.
    expect(redis.ltrim).toHaveBeenCalledWith('video-room:{r1}:chat:recent', 0, 2);
    expect(redis.expire).toHaveBeenCalledWith('video-room:{r1}:chat:recent', 3600);
  });

  it('reads the buffer back as parsed payloads', async () => {
    redis.lrange.mockResolvedValue([JSON.stringify(message('m1'))]);

    const result = await service.readRecent('r1', 10);

    expect(redis.lrange).toHaveBeenCalledWith('video-room:{r1}:chat:recent', 0, 9);
    expect(result).toEqual([message('m1')]);
  });

  it('survives a corrupt buffer entry instead of throwing', async () => {
    // A poisoned cache entry must never take down the read path — the
    // buffer is a cache, and Postgres remains the source of truth.
    redis.lrange.mockResolvedValue(['not-json', JSON.stringify(message('m2'))]);

    const result = await service.readRecent('r1', 10);

    expect(result).toEqual([message('m2')]);
  });

  it('records a typing user with an absolute expiry score', async () => {
    await service.markTyping('r1', 'u1', 5);

    expect(redis.zadd).toHaveBeenCalledWith(
      'video-room:{r1}:chat:typing',
      expect.any(Number),
      'u1',
    );
    const score = redis.zadd.mock.calls[0][1];
    expect(score).toBeGreaterThan(Date.now());
  });

  it('drops expired typers when reading the roster', async () => {
    const now = 1_000_000;
    redis.zrangebyscore.mockResolvedValue(['u1']);

    const result = await service.readTyping('r1', now);

    expect(redis.zremrangebyscore).toHaveBeenCalledWith('video-room:{r1}:chat:typing', '-inf', now);
    expect(redis.zrangebyscore).toHaveBeenCalledWith('video-room:{r1}:chat:typing', now, '+inf');
    expect(result).toEqual(['u1']);
  });
});
