import { VideoRoomTypingService } from './video-room-typing.service';

const ACTOR = { id: 'u1', roles: [] };

describe('VideoRoomTypingService', () => {
  let cache: { markTyping: jest.Mock; clearTyping: jest.Mock; readTyping: jest.Mock };
  let policy: { assertActiveMember: jest.Mock };
  let bus: { publish: jest.Mock };
  let config: { get: jest.Mock };
  let service: VideoRoomTypingService;

  beforeEach(() => {
    cache = {
      markTyping: jest.fn(),
      clearTyping: jest.fn(),
      readTyping: jest.fn().mockResolvedValue(['u1', 'u2']),
    };
    policy = { assertActiveMember: jest.fn() };
    bus = { publish: jest.fn() };
    config = { get: jest.fn().mockReturnValue({ typingTtlSeconds: 5 }) };
    service = new VideoRoomTypingService(
      cache as never,
      policy as never,
      bus as never,
      config as never,
    );
  });

  it('marks the user typing with the configured TTL and announces it', async () => {
    await service.start(ACTOR as never, 'r1');

    expect(policy.assertActiveMember).toHaveBeenCalledWith('r1', 'u1');
    expect(cache.markTyping).toHaveBeenCalledWith('r1', 'u1', 5);
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_typing_started');
  });

  it('clears the marker and announces a stop', async () => {
    await service.stop(ACTOR as never, 'r1');

    expect(cache.clearTyping).toHaveBeenCalledWith('r1', 'u1');
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_typing_stopped');
  });

  it('reads the roster, letting the cache prune expired entries', async () => {
    const roster = await service.roster('r1');
    expect(cache.readTyping).toHaveBeenCalledWith('r1', expect.any(Number));
    expect(roster).toEqual(['u1', 'u2']);
  });

  it('rejects a non-member typing', async () => {
    policy.assertActiveMember.mockRejectedValue(new Error('not a member'));
    await expect(service.start(ACTOR as never, 'r1')).rejects.toThrow('not a member');
    expect(cache.markTyping).not.toHaveBeenCalled();
  });
});
