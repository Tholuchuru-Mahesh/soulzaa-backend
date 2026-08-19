// src/infra/redis/presence.service.spec.ts
import { PresenceService } from './presence.service';

describe('PresenceService — room presence', () => {
  let client: Record<string, jest.Mock>;
  let service: PresenceService;

  beforeEach(() => {
    client = {
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      scard: jest.fn().mockResolvedValue(0),
      sismember: jest.fn().mockResolvedValue(0),
      smembers: jest.fn().mockResolvedValue([]),
      del: jest.fn().mockResolvedValue(1),
    };
    service = new PresenceService(client as never);
  });

  it('joinRoom() with isModerator=true writes to the moderators set, not the public members set', async () => {
    await service.joinRoom('room-1', 'mod-1', true);
    expect(client.sadd).toHaveBeenCalledWith('presence:room:{room-1}:moderators', 'mod-1');
    expect(client.sadd).not.toHaveBeenCalledWith('presence:room:{room-1}:members', 'mod-1');
  });

  it('joinRoom() default (no third arg) writes to the public members set', async () => {
    await service.joinRoom('room-1', 'user-1');
    expect(client.sadd).toHaveBeenCalledWith('presence:room:{room-1}:members', 'user-1');
  });

  it('roomMemberCount() only counts the public set', async () => {
    await service.roomMemberCount('room-1');
    expect(client.scard).toHaveBeenCalledWith('presence:room:{room-1}:members');
  });

  it('isInRoom() returns true if the user is in either set', async () => {
    client.sismember.mockImplementation((key: string) =>
      Promise.resolve(key.endsWith(':moderators') ? 1 : 0),
    );
    await expect(service.isInRoom('room-1', 'mod-1')).resolves.toBe(true);
  });

  it('leaveRoom() with isModerator=true removes from the moderators set only', async () => {
    await service.leaveRoom('room-1', 'mod-1', true);
    expect(client.srem).toHaveBeenCalledWith('presence:room:{room-1}:moderators', 'mod-1');
    expect(client.srem).not.toHaveBeenCalledWith('presence:room:{room-1}:members', 'mod-1');
  });

  it('roomModerators() reads only the moderator set, not the public one', async () => {
    await service.roomModerators('room-1');
    expect(client.smembers).toHaveBeenCalledWith('presence:room:{room-1}:moderators');
    expect(client.smembers).not.toHaveBeenCalledWith('presence:room:{room-1}:members');
  });

  it('leaveRoomEverywhere() removes from both the public and moderator sets', async () => {
    await service.leaveRoomEverywhere('room-1', 'user-1');
    expect(client.srem).toHaveBeenCalledWith('presence:room:{room-1}:members', 'user-1');
    expect(client.srem).toHaveBeenCalledWith('presence:room:{room-1}:moderators', 'user-1');
  });
});
