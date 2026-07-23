import { VideoRoomsNotificationController } from './video-rooms-notification.controller';

describe('VideoRoomsNotificationController', () => {
  const mute = {
    mute: jest.fn().mockResolvedValue(undefined),
    unmute: jest.fn().mockResolvedValue(undefined),
    listMuted: jest.fn().mockResolvedValue(['r1']),
  };
  const system = { broadcast: jest.fn().mockResolvedValue(undefined) };
  const ctrl = new VideoRoomsNotificationController(mute as never, system as never);
  const user = { id: 'u1', roles: [] } as never;

  it('POST mute delegates to the service', async () => {
    await ctrl.mute(user, 'r1');
    expect(mute.mute).toHaveBeenCalledWith('u1', 'r1');
  });

  it('DELETE mute delegates to unmute', async () => {
    await ctrl.unmute(user, 'r1');
    expect(mute.unmute).toHaveBeenCalledWith('u1', 'r1');
  });

  it('GET mute lists muted rooms and reports membership', async () => {
    const res = await ctrl.status(user, 'r1');
    expect(res).toEqual({ roomId: 'r1', muted: true });
  });

  it('POST system delegates to system.broadcast with the actor, room id, and dto', async () => {
    const dto = { title: 't', body: 'b' };
    const res = await ctrl.broadcastSystem(user, 'r1', dto);
    expect(system.broadcast).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r1', dto);
    expect(res).toEqual({ queued: true });
  });
});
