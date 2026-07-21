import type { ConfigService } from '@nestjs/config';
import { VideoRoomMemberRole } from '@prisma/client';
import { VideoRoomRoleMonitor } from './video-room-role.monitor';

describe('VideoRoomRoleMonitor', () => {
  let roles: any;
  let moderation: any;
  let cache: any;
  let locks: any;
  let bus: any;
  let release: jest.Mock;
  let subject: VideoRoomRoleMonitor;

  const config = {
    get: jest.fn().mockReturnValue({ cleanupIntervalSeconds: 30, reconnectTimeoutSeconds: 120 }),
  } as unknown as ConfigService;

  beforeEach(() => {
    release = jest.fn().mockResolvedValue(undefined);
    roles = {
      listExpired: jest.fn().mockResolvedValue([]),
      deleteByIds: jest.fn().mockResolvedValue(0),
    };
    moderation = { appendAction: jest.fn() };
    cache = { invalidateRoom: jest.fn() };
    locks = { acquire: jest.fn().mockResolvedValue(release) };
    bus = { publish: jest.fn() };
    subject = new VideoRoomRoleMonitor(roles, moderation, cache, locks, bus, config);
  });

  const expiredGrant = (id: string, roomId: string, userId: string) => ({
    id,
    roomId,
    userId,
    role: VideoRoomMemberRole.ADMIN,
  });

  it('does nothing when no grants have expired', async () => {
    await expect(subject.sweep()).resolves.toBe(0);
    expect(roles.deleteByIds).not.toHaveBeenCalled();
    expect(cache.invalidateRoom).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('deletes expired grants and announces each one', async () => {
    roles.listExpired.mockResolvedValue([
      expiredGrant('g1', 'r1', 'u1'),
      expiredGrant('g2', 'r1', 'u2'),
    ]);
    roles.deleteByIds.mockResolvedValue(2);

    await expect(subject.sweep()).resolves.toBe(2);
    expect(roles.deleteByIds).toHaveBeenCalledWith(['g1', 'g2']);
    expect(bus.publish).toHaveBeenCalledTimes(2);
    expect(moderation.appendAction).toHaveBeenCalledTimes(2);
  });

  it('records the expiry as a system action with no moderator', async () => {
    roles.listExpired.mockResolvedValue([expiredGrant('g1', 'r1', 'u1')]);
    roles.deleteByIds.mockResolvedValue(1);
    await subject.sweep();
    expect(moderation.appendAction).toHaveBeenCalledWith(
      expect.objectContaining({
        moderatorId: null,
        action: 'ROLE_REVOKED',
        metadata: expect.objectContaining({ automatic: true }),
      }),
    );
  });

  // The version key is room-scoped, so two lapsed grants in one room need one
  // bump, not two.
  it('invalidates each affected room exactly once', async () => {
    roles.listExpired.mockResolvedValue([
      expiredGrant('g1', 'r1', 'u1'),
      expiredGrant('g2', 'r1', 'u2'),
      expiredGrant('g3', 'r2', 'u3'),
    ]);
    roles.deleteByIds.mockResolvedValue(3);

    await subject.sweep();
    expect(cache.invalidateRoom).toHaveBeenCalledTimes(2);
    expect(cache.invalidateRoom).toHaveBeenCalledWith('r1');
    expect(cache.invalidateRoom).toHaveBeenCalledWith('r2');
  });

  it('takes the fleet-wide lock and releases it', async () => {
    await subject.sweep();
    expect(locks.acquire).toHaveBeenCalledWith('video-room:role:monitor', expect.any(Number));
    expect(release).toHaveBeenCalled();
  });

  it('yields when another instance already holds the lock', async () => {
    locks.acquire.mockResolvedValue(null);
    await expect(subject.sweep()).resolves.toBe(0);
    expect(roles.listExpired).not.toHaveBeenCalled();
  });

  it('releases the lock even when the purge throws', async () => {
    roles.listExpired.mockRejectedValue(new Error('db down'));
    await expect(subject.sweep()).resolves.toBe(0);
    expect(release).toHaveBeenCalled();
  });

  // A background sweep that throws must never take the process down.
  it('swallows errors and reports zero', async () => {
    locks.acquire.mockRejectedValue(new Error('redis down'));
    await expect(subject.sweep()).resolves.toBe(0);
  });
});
