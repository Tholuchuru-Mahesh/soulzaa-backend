// src/modules/video-rooms/services/video-room-presence.service.spec.ts
import { VideoRoomPresenceService } from './video-room-presence.service';

describe('VideoRoomPresenceService — moderator presence', () => {
  let redis: Record<string, jest.Mock>;
  let service: VideoRoomPresenceService;

  beforeEach(() => {
    redis = {
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      sismember: jest.fn().mockResolvedValue(0),
      scard: jest.fn().mockResolvedValue(0),
      del: jest.fn().mockResolvedValue(1),
    };
    service = new VideoRoomPresenceService(redis as never);
  });

  it('addModerator() writes to the moderators key, not the viewers key', async () => {
    await service.addModerator('room-1', 'mod-1');
    expect(redis.sadd).toHaveBeenCalledWith('video-room:{room-1}:moderators', 'mod-1');
    expect(redis.sadd).not.toHaveBeenCalledWith('video-room:{room-1}:viewers', 'mod-1');
  });

  it('viewerCount() is unaffected by moderator presence (reads only the viewers key)', async () => {
    await service.viewerCount('room-1');
    expect(redis.scard).toHaveBeenCalledWith('video-room:{room-1}:viewers');
  });

  it('isModeratorPresent() reads the moderators key', async () => {
    redis.sismember.mockResolvedValueOnce(1);
    await expect(service.isModeratorPresent('room-1', 'mod-1')).resolves.toBe(true);
    expect(redis.sismember).toHaveBeenCalledWith('video-room:{room-1}:moderators', 'mod-1');
  });

  it('clearRoom() also deletes the moderators key', async () => {
    await service.clearRoom('room-1');
    expect(redis.del).toHaveBeenCalledWith(
      'video-room:{room-1}:viewers',
      'video-room:{room-1}:hosts',
      'video-room:{room-1}:participants',
      'video-room:{room-1}:moderators',
    );
  });
});
