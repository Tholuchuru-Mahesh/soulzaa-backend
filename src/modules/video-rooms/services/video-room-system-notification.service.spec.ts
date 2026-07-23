import { VideoRoomSystemNotificationService } from './video-room-system-notification.service';

describe('VideoRoomSystemNotificationService', () => {
  it('asserts MANAGE_ANNOUNCEMENTS then dispatches a SYSTEM notification to room members', async () => {
    const rooms = { findById: jest.fn().mockResolvedValue({ id: 'r1' }) };
    const permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    const notifications = { dispatchSystem: jest.fn().mockResolvedValue(undefined) };
    const svc = new VideoRoomSystemNotificationService(
      permissions as never,
      rooms as never,
      notifications as never,
    );
    await svc.broadcast({ id: 'u1', roles: [] } as never, 'r1', { title: 't', body: 'b' });
    expect(permissions.assertPermission).toHaveBeenCalled();
    expect(notifications.dispatchSystem).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r1', audience: 'ROOM_MEMBERS', title: 't', body: 'b' }),
    );
  });

  it('throws NOT_FOUND when the room does not exist', async () => {
    const rooms = { findById: jest.fn().mockResolvedValue(null) };
    const permissions = { assertPermission: jest.fn() };
    const notifications = { dispatchSystem: jest.fn() };
    const svc = new VideoRoomSystemNotificationService(
      permissions as never,
      rooms as never,
      notifications as never,
    );
    await expect(
      svc.broadcast({ id: 'u1', roles: [] } as never, 'r1', { title: 't', body: 'b' }),
    ).rejects.toBeDefined();
    expect(notifications.dispatchSystem).not.toHaveBeenCalled();
  });
});
