import type { ConfigService } from '@nestjs/config';
import { VideoRoomSessionMonitor } from './video-room-session.monitor';

function configMock(): ConfigService {
  return {
    get: jest.fn().mockReturnValue({ cleanupIntervalSeconds: 30, reconnectTimeoutSeconds: 120 }),
  } as unknown as ConfigService;
}

describe('VideoRoomSessionMonitor', () => {
  let sessions: any;
  let members: any;
  let locks: any;
  let monitor: VideoRoomSessionMonitor;

  beforeEach(() => {
    sessions = { expireStale: jest.fn().mockResolvedValue([]) };
    members = { reclaim: jest.fn().mockResolvedValue(undefined) };
    // acquire returns a release fn so the critical section runs.
    locks = { acquire: jest.fn().mockResolvedValue(async () => undefined) };
    monitor = new VideoRoomSessionMonitor(sessions, members, locks, configMock());
  });

  it('reclaims each stale session through the member service', async () => {
    const rows = [
      { roomId: 'r1', userId: 'u1', socketId: 's1', joinedAt: new Date() },
      { roomId: 'r2', userId: 'u2', socketId: null, joinedAt: new Date() },
    ];
    sessions.expireStale.mockResolvedValue(rows);

    await (monitor as any).sweep();

    expect(sessions.expireStale).toHaveBeenCalledWith(expect.any(Date));
    expect(members.reclaim).toHaveBeenCalledTimes(2);
    expect(members.reclaim).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r1', userId: 'u1', socketId: 's1' }),
    );
  });

  it('does nothing when another instance holds the sweep lock', async () => {
    locks.acquire.mockResolvedValue(null);
    await (monitor as any).sweep();
    expect(sessions.expireStale).not.toHaveBeenCalled();
  });
});
