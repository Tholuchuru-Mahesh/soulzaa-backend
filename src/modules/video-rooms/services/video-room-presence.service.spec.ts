import { VideoRoomPresenceService } from './video-room-presence.service';

describe('VideoRoomPresenceService', () => {
  let redis: any;
  let service: VideoRoomPresenceService;

  beforeEach(() => {
    redis = {
      sadd: jest.fn(),
      srem: jest.fn(),
      sismember: jest.fn().mockResolvedValue(1),
      scard: jest.fn().mockResolvedValue(3),
      del: jest.fn(),
    };
    service = new VideoRoomPresenceService(redis);
  });

  it('adds a viewer to the room viewers set', async () => {
    await service.addViewer('r1', 'u1');
    expect(redis.sadd).toHaveBeenCalledWith(expect.stringContaining('r1'), 'u1');
  });

  it('reports viewer count from the set cardinality', async () => {
    expect(await service.viewerCount('r1')).toBe(3);
  });

  it('reports membership from set-membership check', async () => {
    expect(await service.isViewer('r1', 'u1')).toBe(true);
    redis.sismember.mockResolvedValue(0);
    expect(await service.isHost('r1', 'u1')).toBe(false);
  });

  it('reports participant membership from set-membership check', async () => {
    expect(await service.isParticipant('r1', 'u2')).toBe(true);
    redis.sismember.mockResolvedValue(0);
    expect(await service.isParticipant('r1', 'u2')).toBe(false);
  });

  it('tracks hosts and participants in distinct sets', async () => {
    await service.addHost('r1', 'u1');
    await service.addParticipant('r1', 'u2');
    const hostKey = redis.sadd.mock.calls[0][0];
    const participantKey = redis.sadd.mock.calls[1][0];
    expect(hostKey).not.toBe(participantKey);
  });

  it('clearRoom drops all three role sets in one (single-slot) DEL', async () => {
    await service.clearRoom('r1');
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del.mock.calls[0]).toHaveLength(3);
  });
});
