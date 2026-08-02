import { ConfigService } from '@nestjs/config';
import { DevicePlatform } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { TokenService } from 'src/infra/auth/token.service';
import { SessionRepository } from '../repositories/session.repository';
import { sha256 } from '../hash.util';
import { LoginTelemetryService } from './login-telemetry.service';
import { SessionService } from './session.service';
import type { SessionClaims } from '../interfaces/session.interface';
import type { IDeviceService } from 'src/modules/device/interfaces/device.interface';

const CLAIMS: SessionClaims = { userId: 'u1', roles: ['USER'], isGuest: false };
const CFG = { inactivitySeconds: 1800, hijackStrictIp: false };

/** A syntactically-valid JWT whose payload carries the given exp (seconds). */
function fakeJwt(expSeconds: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: expSeconds })}.sig`;
}
const future = () => Math.floor(Date.now() / 1000) + 3600;

describe('SessionService', () => {
  let repo: jest.Mocked<
    Pick<
      SessionRepository,
      | 'createSession'
      | 'cacheSession'
      | 'addToUserIndex'
      | 'recordEvent'
      | 'getSession'
      | 'markSessionRotated'
      | 'removeFromUserIndex'
      | 'destroyCachedSession'
      | 'userIndexMembers'
      | 'revokeAllSessions'
      | 'clearUserIndex'
      | 'revokeSession'
    >
  >;
  let tokens: jest.Mocked<Pick<TokenService, 'signPair'>>;
  let cache: jest.Mocked<Pick<CacheService, 'get' | 'increment'>>;
  let bus: jest.Mocked<IEventBus>;
  let devices: jest.Mocked<Pick<IDeviceService, 'registerDevice' | 'getDeviceByIdentifier'>>;
  let service: SessionService;

  beforeEach(() => {
    repo = {
      createSession: jest.fn().mockResolvedValue({}),
      cacheSession: jest.fn().mockResolvedValue(undefined),
      addToUserIndex: jest.fn().mockResolvedValue(undefined),
      recordEvent: jest.fn().mockResolvedValue(undefined),
      getSession: jest.fn(),
      markSessionRotated: jest.fn().mockResolvedValue({}),
      removeFromUserIndex: jest.fn().mockResolvedValue(undefined),
      destroyCachedSession: jest.fn().mockResolvedValue(undefined),
      userIndexMembers: jest.fn().mockResolvedValue([]),
      revokeAllSessions: jest.fn().mockResolvedValue({ count: 0 }),
      clearUserIndex: jest.fn().mockResolvedValue(undefined),
      revokeSession: jest.fn().mockResolvedValue({ count: 1 }),
    };
    tokens = {
      signPair: jest
        .fn()
        .mockResolvedValue({ accessToken: fakeJwt(future()), refreshToken: fakeJwt(future()) }),
    };
    cache = { get: jest.fn().mockResolvedValue(null), increment: jest.fn().mockResolvedValue(1) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    devices = {
      registerDevice: jest.fn().mockResolvedValue({
        deviceId: 'dev1',
        platform: DevicePlatform.IOS,
        trusted: false,
        isNew: true,
        suspicious: false,
      }),
      getDeviceByIdentifier: jest.fn(),
    };
    const config = { get: () => CFG } as unknown as ConfigService;
    service = new SessionService(
      repo as unknown as SessionRepository,
      tokens as unknown as TokenService,
      cache as unknown as CacheService,
      bus,
      devices as unknown as IDeviceService,
      // Telemetry is observational; a stub keeps these tests about session mechanics.
      new LoginTelemetryService(),
      config,
    );
  });

  describe('createSession', () => {
    it('persists the row, caches the blob, indexes it and emits session.created', async () => {
      const ctx = {
        ip: '1.2.3.4',
        device: { deviceIdentifier: 'd', platform: DevicePlatform.IOS },
      };
      const result = await service.createSession(CLAIMS, ctx);
      expect(devices.registerDevice).toHaveBeenCalled();
      const created = repo.createSession.mock.calls[0][0];
      expect(created.id).toBe(result.sessionId);
      expect(created.refreshTokenHash).toBe(sha256(result.tokens.refreshToken));
      expect(repo.addToUserIndex).toHaveBeenCalledWith('u1', result.sessionId);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'session.created' }),
      );
    });
  });

  describe('refresh', () => {
    const liveSession = (over: Record<string, unknown> = {}) =>
      ({
        id: 'old',
        userId: 'u1',
        deviceId: 'dev1',
        refreshTokenHash: sha256('good-refresh'),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        createdByIp: '1.2.3.4',
        ...over,
      }) as never;

    it('rotates a valid token and retires the old session', async () => {
      repo.getSession.mockResolvedValue(liveSession());
      await service.refresh('u1', 'old', 'good-refresh', CLAIMS, {});
      expect(repo.markSessionRotated).toHaveBeenCalledWith('old', expect.any(String));
      expect(repo.destroyCachedSession).toHaveBeenCalledWith('old');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'session.refreshed' }),
      );
    });

    it('detects reuse of a revoked/rotated token and revokes all', async () => {
      repo.getSession.mockResolvedValue(liveSession({ revokedAt: new Date() }));
      repo.userIndexMembers.mockResolvedValue(['old', 's2']);
      await expect(service.refresh('u1', 'old', 'good-refresh', CLAIMS, {})).rejects.toMatchObject({
        errorCode: 'TOKEN_REUSE_DETECTED',
      });
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('u1');
    });

    it('detects a hijack when the presented device differs from the bound device', async () => {
      repo.getSession.mockResolvedValue(liveSession());
      devices.getDeviceByIdentifier.mockResolvedValue({ id: 'other-dev' });
      await expect(
        service.refresh('u1', 'old', 'good-refresh', CLAIMS, {
          device: { deviceIdentifier: 'x', platform: DevicePlatform.WEB },
        }),
      ).rejects.toMatchObject({ errorCode: 'SESSION_HIJACK_DETECTED' });
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('u1');
    });

    it('rejects an unknown/expired session', async () => {
      repo.getSession.mockResolvedValue(null);
      await expect(service.refresh('u1', 'x', 't', CLAIMS, {})).rejects.toMatchObject({
        errorCode: 'SESSION_EXPIRED',
      });
    });
  });

  describe('revocation', () => {
    it('revokeSession clears the cache blob + index and emits session.revoked', async () => {
      await service.revokeSession('u1', 's1', 'user');
      expect(repo.revokeSession).toHaveBeenCalledWith('s1');
      expect(repo.destroyCachedSession).toHaveBeenCalledWith('s1');
      expect(repo.removeFromUserIndex).toHaveBeenCalledWith('u1', 's1');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'session.revoked' }),
      );
    });

    it('revokeAllForUser bumps the epoch and clears the user index', async () => {
      repo.userIndexMembers.mockResolvedValue(['s1', 's2']);
      await service.revokeAllForUser('u1', 'user');
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('u1');
      expect(repo.destroyCachedSession).toHaveBeenCalledTimes(2);
      expect(repo.clearUserIndex).toHaveBeenCalledWith('u1');
      expect(cache.increment).toHaveBeenCalled();
    });
  });
});
