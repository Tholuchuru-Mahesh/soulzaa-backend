import type { ConfigService } from '@nestjs/config';
import { VideoRoomMemberRole } from '@prisma/client';
import { VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import { ConnectionType, VideoRoomPresenceState } from '../enums';
import { VideoRoomSessionService } from './video-room-session.service';

function configMock(): ConfigService {
  return {
    get: jest.fn().mockReturnValue({
      sessionTtlSeconds: 90,
      heartbeatIntervalSeconds: 25,
      reconnectTimeoutSeconds: 120,
      idleTimeoutSeconds: 300,
    }),
  } as unknown as ConfigService;
}

describe('VideoRoomSessionService', () => {
  let redis: any;
  let cache: any;
  let repo: any;
  let sockets: any;
  let events: any;
  let metrics: any;
  let service: VideoRoomSessionService;

  beforeEach(() => {
    redis = { smembers: jest.fn().mockResolvedValue([]), sadd: jest.fn(), srem: jest.fn() };
    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() };
    repo = {
      upsertPresence: jest.fn(),
      touchPresence: jest.fn(),
      removePresence: jest.fn(),
      findStalePresence: jest.fn().mockResolvedValue([]),
    };
    sockets = { emitToUserEverywhere: jest.fn() };
    events = { emitUserDisconnected: jest.fn().mockResolvedValue(undefined) };
    metrics = { incHeartbeatFailure: jest.fn(), incDuplicateSession: jest.fn() };
    service = new VideoRoomSessionService(
      redis,
      cache,
      repo,
      sockets,
      events,
      metrics,
      configMock(),
    );
  });

  it('register writes the record + room set + user reverse index + durable mirror', async () => {
    const res = await service.register({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's1',
      role: ConnectionType.SUBSCRIBER,
    });

    expect(res.duplicateOf).toBeNull();
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining('s1'),
      expect.objectContaining({
        userId: 'u1',
        roomId: 'r1',
        presenceState: VideoRoomPresenceState.CONNECTING,
      }),
      90,
    );
    expect(redis.sadd).toHaveBeenCalledWith(expect.stringContaining('r1'), 's1');
    expect(redis.sadd).toHaveBeenCalledWith(expect.stringContaining('u1'), 's1');
    expect(repo.upsertPresence).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r1', userId: 'u1', role: VideoRoomMemberRole.VIEWER }),
    );
  });

  it('register evicts a duplicate same-device session and disconnects it', async () => {
    redis.smembers.mockResolvedValue(['s0']);
    cache.get.mockResolvedValue({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's0',
      deviceId: 'd1',
      role: ConnectionType.SUBSCRIBER,
      connectedAt: 't',
    });

    const res = await service.register({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's1',
      deviceId: 'd1',
      role: ConnectionType.PUBLISHER,
    });

    expect(res.duplicateOf).toBe('s0');
    // Old socket torn down + told to drop, UserDisconnected published, metric bumped.
    expect(redis.srem).toHaveBeenCalledWith(expect.stringContaining('r1'), 's0');
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u1',
      VIDEO_ROOM_SOCKET_EVENTS.SESSION_EVICTED,
      { roomId: 'r1', evictedSocketId: 's0' },
    );
    expect(events.emitUserDisconnected).toHaveBeenCalledWith(
      expect.objectContaining({ socketId: 's0', reason: 'duplicate_session' }),
    );
    expect(metrics.incDuplicateSession).toHaveBeenCalled();
  });

  it('register does NOT evict a different device (multi-device allowed)', async () => {
    redis.smembers.mockResolvedValue(['s0']);
    cache.get.mockResolvedValue({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's0',
      deviceId: 'd1',
      role: ConnectionType.SUBSCRIBER,
      connectedAt: 't',
    });

    const res = await service.register({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's1',
      deviceId: 'd2',
      role: ConnectionType.SUBSCRIBER,
    });

    expect(res.duplicateOf).toBeNull();
    expect(sockets.emitToUserEverywhere).not.toHaveBeenCalled();
    expect(metrics.incDuplicateSession).not.toHaveBeenCalled();
  });

  it('register maps a PUBLISHER connection to the PARTICIPANT member role', async () => {
    await service.register({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's1',
      role: ConnectionType.PUBLISHER,
    });
    expect(repo.upsertPresence).toHaveBeenCalledWith(
      expect.objectContaining({ role: VideoRoomMemberRole.PARTICIPANT }),
    );
  });

  it('heartbeat returns false + records a failure for an unknown session', async () => {
    cache.get.mockResolvedValue(null);
    expect(await service.heartbeat('sX')).toBe(false);
    expect(metrics.incHeartbeatFailure).toHaveBeenCalled();
  });

  it('heartbeat flushes the durable mirror when the mirror is stale', async () => {
    cache.get.mockResolvedValue({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's1',
      role: ConnectionType.SUBSCRIBER,
      inBackground: false,
      connectedAt: 't',
      lastSeenAt: 't',
      lastMirrorAt: new Date(Date.now() - 60_000).toISOString(),
      reconnectCount: 0,
    });
    expect(await service.heartbeat('s1')).toBe(true);
    expect(repo.touchPresence).toHaveBeenCalledWith('r1', 'u1');
  });

  it('heartbeat skips the durable write when the mirror is fresh (lazy)', async () => {
    cache.get.mockResolvedValue({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's1',
      role: ConnectionType.SUBSCRIBER,
      inBackground: false,
      connectedAt: 't',
      lastSeenAt: 't',
      lastMirrorAt: new Date().toISOString(),
      reconnectCount: 0,
    });
    expect(await service.heartbeat('s1')).toBe(true);
    expect(cache.set).toHaveBeenCalled();
    expect(repo.touchPresence).not.toHaveBeenCalled();
  });

  it('heartbeat marks IDLE when the client reports it is backgrounded', async () => {
    cache.get.mockResolvedValue({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's1',
      role: ConnectionType.SUBSCRIBER,
      inBackground: false,
      connectedAt: 't',
      lastSeenAt: 't',
      lastMirrorAt: new Date().toISOString(),
      reconnectCount: 0,
    });
    await service.heartbeat('s1', { inBackground: true });
    const written = cache.set.mock.calls[0][1];
    expect(written.presenceState).toBe(VideoRoomPresenceState.IDLE);
    expect(written.inBackground).toBe(true);
  });

  it('end tears down the record, both sets, and the durable presence', async () => {
    cache.get.mockResolvedValue({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's1',
      role: ConnectionType.SUBSCRIBER,
      connectedAt: 't',
    });

    const rec = await service.end('s1');

    expect(cache.del).toHaveBeenCalledWith(expect.stringContaining('s1'));
    expect(redis.srem).toHaveBeenCalledWith(expect.stringContaining('r1'), 's1');
    expect(redis.srem).toHaveBeenCalledWith(expect.stringContaining('u1'), 's1');
    expect(repo.removePresence).toHaveBeenCalledWith('r1', 'u1');
    expect(rec?.userId).toBe('u1');
  });

  it('endUserRoomSessions ends only the user sockets in the given room', async () => {
    redis.smembers.mockResolvedValue(['s1', 's2']);
    cache.get.mockImplementation((key: string) =>
      key.includes('s1')
        ? Promise.resolve({ roomId: 'r1', userId: 'u1', socketId: 's1', connectedAt: 't' })
        : Promise.resolve({ roomId: 'r2', userId: 'u1', socketId: 's2', connectedAt: 't' }),
    );

    const ended = await service.endUserRoomSessions('r1', 'u1');

    expect(ended.map((r) => r.socketId)).toEqual(['s1']);
    expect(redis.srem).toHaveBeenCalledWith(expect.stringContaining('r1'), 's1');
    expect(redis.srem).not.toHaveBeenCalledWith(expect.stringContaining('r2'), 's2');
  });

  it('markPresence stamps a new state without sliding lastSeenAt', async () => {
    cache.get.mockResolvedValue({
      roomId: 'r1',
      userId: 'u1',
      socketId: 's1',
      role: ConnectionType.SUBSCRIBER,
      connectedAt: 't',
      lastSeenAt: 'original',
      lastMirrorAt: 'original',
      presenceState: VideoRoomPresenceState.ONLINE,
      inBackground: false,
      reconnectCount: 0,
    });
    const rec = await service.markPresence('s1', VideoRoomPresenceState.DISCONNECTED);
    expect(rec?.presenceState).toBe(VideoRoomPresenceState.DISCONNECTED);
    expect(rec?.lastSeenAt).toBe('original');
    expect(repo.touchPresence).not.toHaveBeenCalled();
  });

  it('expireStale reclaims stale presence rows (with or without a socket id)', async () => {
    repo.findStalePresence.mockResolvedValue([
      { roomId: 'r1', userId: 'u1', socketId: 's1' },
      { roomId: 'r2', userId: 'u2', socketId: null },
    ]);

    const reclaimed = await service.expireStale(new Date('2020-01-01T00:00:00.000Z'));

    expect(reclaimed).toHaveLength(2);
    expect(cache.del).toHaveBeenCalledWith(expect.stringContaining('s1'));
    expect(repo.removePresence).toHaveBeenCalledWith('r1', 'u1');
    expect(repo.removePresence).toHaveBeenCalledWith('r2', 'u2');
  });
});
