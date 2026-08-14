import { ConfigService } from '@nestjs/config';
import { DevicePlatform } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { SessionRepository } from '../repositories/session.repository';
import { SessionManager } from './session.manager';
import { SessionService } from './session.service';
import type { SessionClaims } from '../interfaces/session.interface';
import type { IDeviceService } from 'src/modules/device/interfaces/device.interface';

const CLAIMS: SessionClaims = { userId: 'u1', roles: ['USER'], isGuest: false };

function activeSession(id: string) {
  return {
    id,
    userId: 'u1',
    deviceId: 'dev1',
    platform: DevicePlatform.IOS,
    createdByIp: '1.2.3.4',
    userAgent: 'ua',
    lastActivityAt: new Date(),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  } as never;
}

describe('SessionManager', () => {
  let service: jest.Mocked<
    Pick<SessionService, 'createSession' | 'refresh' | 'revokeSession' | 'revokeAllForUser'>
  >;
  let repo: jest.Mocked<
    Pick<SessionRepository, 'listActiveSessions' | 'getSession' | 'recordEvent'>
  >;
  let bus: jest.Mocked<IEventBus>;
  let devices: jest.Mocked<Pick<IDeviceService, 'isTrusted' | 'trustDevice' | 'untrustDevice'>>;
  let manager: SessionManager;

  beforeEach(() => {
    service = {
      createSession: jest.fn().mockResolvedValue({ sessionId: 'new', tokens: {} }),
      refresh: jest.fn(),
      revokeSession: jest.fn().mockResolvedValue(undefined),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };
    repo = {
      listActiveSessions: jest.fn().mockResolvedValue([]),
      getSession: jest.fn(),
      recordEvent: jest.fn().mockResolvedValue(undefined),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    devices = {
      isTrusted: jest.fn().mockResolvedValue(false),
      trustDevice: jest.fn().mockResolvedValue(undefined),
      untrustDevice: jest.fn().mockResolvedValue(undefined),
    };
    const config = { get: () => ({ maxConcurrent: 3 }) } as unknown as ConfigService;
    manager = new SessionManager(
      service as unknown as SessionService,
      repo as unknown as SessionRepository,
      bus,
      devices as unknown as IDeviceService,
      // getMaxConcurrentLimit() reads the viewer's roles to cap moderators at a
      // single session; these tests are about the ordinary limit, so the user
      // resolves as a non-moderator.
      {
        user: { findUnique: jest.fn().mockResolvedValue({ roles: ['USER'] }) },
        userRole: { findFirst: jest.fn().mockResolvedValue(null) },
      } as any,
      config,
    );
  });

  describe('createSession (concurrent limit)', () => {
    it('mints without eviction when under the limit', async () => {
      repo.listActiveSessions.mockResolvedValue([activeSession('a'), activeSession('b')]);
      await manager.createSession(CLAIMS, {});
      expect(service.revokeSession).not.toHaveBeenCalled();
      expect(service.createSession).toHaveBeenCalled();
    });

    it('evicts the oldest sessions to make room at the limit', async () => {
      // 3 active + limit 3 → evict 1 (the oldest, listed first) before minting.
      repo.listActiveSessions.mockResolvedValue([
        activeSession('oldest'),
        activeSession('b'),
        activeSession('c'),
      ]);
      await manager.createSession(CLAIMS, {});
      expect(service.revokeSession).toHaveBeenCalledWith('u1', 'oldest', 'concurrent');
      expect(service.createSession).toHaveBeenCalled();
    });
  });

  it('logoutAll delegates to revokeAllForUser and emits session.logged_out', async () => {
    await manager.logoutAll('u1');
    expect(service.revokeAllForUser).toHaveBeenCalledWith('u1', 'user');
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'session.logged_out' }),
    );
  });

  it('adminForceLogout revokes all + records an ADMIN_LOGOUT audit row', async () => {
    await manager.adminForceLogout('target', 'admin1');
    expect(service.revokeAllForUser).toHaveBeenCalledWith('target', 'admin');
    expect(repo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'target', event: 'ADMIN_LOGOUT' }),
    );
  });

  it('revoke enforces ownership before revoking', async () => {
    repo.getSession.mockResolvedValue({ id: 's1', userId: 'someone-else' } as never);
    await expect(manager.revoke('u1', 's1')).rejects.toMatchObject({
      errorCode: 'SESSION_NOT_FOUND',
    });
    expect(service.revokeSession).not.toHaveBeenCalled();
  });

  it('trustDevice delegates to the device service for an owned session', async () => {
    repo.getSession.mockResolvedValue({ id: 's1', userId: 'u1', deviceId: 'dev1' } as never);
    await manager.trustDevice('u1', 's1', true);
    expect(devices.trustDevice).toHaveBeenCalledWith('u1', 'dev1');
  });

  it('listUserSessions marks the current session and device trust', async () => {
    repo.listActiveSessions.mockResolvedValue([activeSession('s1')]);
    devices.isTrusted.mockResolvedValue(true);
    const views = await manager.listUserSessions('u1', 's1');
    expect(views[0]).toMatchObject({ sessionId: 's1', current: true, trusted: true });
  });
});
