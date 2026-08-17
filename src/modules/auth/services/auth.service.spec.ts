import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { IEventBus } from 'src/common/events';
import type { IRoleSource } from 'src/common/interfaces/role-source.interface';
import { PasswordService } from 'src/infra/auth/password.service';
import type { ModeratorDeviceBindingService } from 'src/modules/device/services/moderator-device-binding.service';
import type { StaffIpAllowlistService } from 'src/modules/device/services/staff-ip-allowlist.service';

jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
  getApps: jest.fn(() => []),
  cert: jest.fn(),
}));
jest.mock('firebase-admin/auth', () => ({
  getAuth: jest.fn(),
}));

import type {
  IUsersService,
  UserIdentity,
} from 'src/modules/users/interfaces/users.service.interface';
import type { ISocialIdentityVerifier } from '../interfaces/social-identity-verifier.interface';
import type { IOtpService } from 'src/modules/otp/interfaces/otp.interface';
import type { ISessionService } from 'src/modules/session/interfaces/session.interface';
import { AuthRepository } from '../repositories/auth.repository';
import { AuthService } from './auth.service';
import { LoginSecurityService } from './login-security.service';
import { FirebaseService } from './firebase.service';

function makeIdentity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    id: 'u1',
    username: 'aditya',
    email: 'aditya@example.com',
    mobile: '+15551234567',
    fullName: 'Aditya',
    gender: null,
    dateOfBirth: new Date('2000-01-01'),
    country: 'IN',
    preferredLanguage: 'en',
    roles: ['USER'],
    isGuest: false,
    status: 'ACTIVE',
    isHiddenAccount: false,
    emailVerifiedAt: null,
    mobileVerifiedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const TOKENS = {
  sessionId: 's1',
  tokens: { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer' as const },
};

describe('AuthService', () => {
  let users: jest.Mocked<IUsersService>;
  let bus: jest.Mocked<IEventBus>;
  let social: jest.Mocked<ISocialIdentityVerifier>;
  let repo: jest.Mocked<AuthRepository>;
  let passwords: jest.Mocked<Pick<PasswordService, 'hash' | 'verify'>>;
  let sessions: jest.Mocked<
    Pick<ISessionService, 'createSession' | 'refresh' | 'logoutCurrent' | 'logoutAll'>
  >;
  let otp: jest.Mocked<IOtpService>;
  let security: jest.Mocked<
    Pick<
      LoginSecurityService,
      'assertNotLocked' | 'recordFailure' | 'recordSuccess' | 'enforceRateLimit'
    >
  >;
  let firebase: jest.Mocked<Pick<FirebaseService, 'verifyIdToken'>>;
  let roleSource: jest.Mocked<IRoleSource>;
  let service: AuthService;

  beforeEach(() => {
    users = {
      findById: jest.fn(),
      findByEmail: jest.fn(),
      findByMobile: jest.fn(),
      findByUsername: jest.fn(),
      isEmailTaken: jest.fn(),
      isMobileTaken: jest.fn(),
      isUsernameTaken: jest.fn(),
      createIdentity: jest.fn(),
      markEmailVerified: jest.fn(),
      markMobileVerified: jest.fn(),
      promoteGuest: jest.fn(),
      updateContact: jest.fn(),
      setHiddenAccount: jest.fn(),
      setStatus: jest.fn(),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    social = { verify: jest.fn() };
    repo = {
      upsertCredential: jest.fn().mockResolvedValue({}),
      ensureProviderMarker: jest.fn().mockResolvedValue(undefined),
      getCredential: jest.fn(),
    } as unknown as jest.Mocked<AuthRepository>;
    passwords = { hash: jest.fn().mockResolvedValue('HASH'), verify: jest.fn() };
    sessions = {
      createSession: jest.fn().mockResolvedValue(TOKENS),
      refresh: jest.fn().mockResolvedValue(TOKENS.tokens),
      logoutCurrent: jest.fn().mockResolvedValue(undefined),
      logoutAll: jest.fn().mockResolvedValue(undefined),
    };
    otp = {
      generate: jest.fn().mockResolvedValue({ sent: true, expiresIn: 60 }),
      resend: jest.fn().mockResolvedValue({ sent: true, expiresIn: 60 }),
      verify: jest.fn().mockResolvedValue(undefined),
    };
    security = {
      assertNotLocked: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      enforceRateLimit: jest.fn().mockResolvedValue(undefined),
    };
    firebase = {
      verifyIdToken: jest.fn(),
    };
    roleSource = {
      getRoleNames: jest.fn().mockResolvedValue([]),
      getUserIdsWithAnyRole: jest.fn().mockResolvedValue([]),
    };
    const config = { get: () => ({ passwordResetTtlSeconds: 900 }) } as unknown as ConfigService;

    service = new AuthService(
      users,
      bus,
      social,
      otp,
      sessions as unknown as ISessionService,
      repo,
      passwords as unknown as PasswordService,
      security as unknown as LoginSecurityService,
      firebase as unknown as FirebaseService,
      config,
      roleSource,
    );
  });

  describe('register', () => {
    it('creates the account, stores credentials, requests OTP and issues tokens', async () => {
      users.createIdentity.mockResolvedValue(makeIdentity());
      const result = await service.register(
        {
          fullName: 'Aditya',
          username: 'aditya',
          mobile: '+15551234567',
          email: 'aditya@example.com',
          password: 'Str0ng@Pass',
          dateOfBirth: '2000-01-01',
          country: 'IN',
        },
        {},
      );

      expect(passwords.hash).toHaveBeenCalledWith('Str0ng@Pass');
      expect(repo.upsertCredential).toHaveBeenCalledWith('u1', 'HASH');
      expect(otp.generate).toHaveBeenCalled();
      expect(result.isNewUser).toBe(true);
      expect(result.tokens.accessToken).toBe('a');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'user.registered' }),
      );
    });

    it('propagates a duplicate-account error from the users service', async () => {
      users.createIdentity.mockRejectedValue({ errorCode: 'DUPLICATE_EMAIL' });
      await expect(
        service.register(
          {
            fullName: 'A',
            username: 'aditya',
            mobile: '+1',
            password: 'Str0ng@Pass',
            dateOfBirth: '2000-01-01',
            country: 'IN',
          },
          {},
        ),
      ).rejects.toMatchObject({ errorCode: 'DUPLICATE_EMAIL' });
    });
  });

  describe('loginWithPassword', () => {
    it('issues tokens on valid credentials', async () => {
      users.findByEmail.mockResolvedValue(makeIdentity());
      repo.getCredential.mockResolvedValue({ passwordHash: 'HASH' } as never);
      passwords.verify.mockResolvedValue(true);

      const result = await service.loginWithPassword(
        { email: 'aditya@example.com', password: 'Str0ng@Pass' },
        {},
      );
      expect(security.recordSuccess).toHaveBeenCalled();
      expect(result.isNewUser).toBe(false);
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'user.logged_in' }));
    });

    it('stamps the token with roles resolved from the RBAC store', async () => {
      // The legacy User.roles column still says USER; RBAC is the source of truth.
      users.findByEmail.mockResolvedValue(makeIdentity({ roles: ['USER'] }));
      repo.getCredential.mockResolvedValue({ passwordHash: 'HASH' } as never);
      passwords.verify.mockResolvedValue(true);
      roleSource.getRoleNames.mockResolvedValue(['ADMIN', 'USER']);

      await service.loginWithPassword({ email: 'aditya@example.com', password: 'Str0ng@Pass' }, {});

      expect(sessions.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', roles: ['ADMIN', 'USER'] }),
        expect.anything(),
      );
    });

    it('records a failure and throws on a bad password', async () => {
      users.findByEmail.mockResolvedValue(makeIdentity());
      repo.getCredential.mockResolvedValue({ passwordHash: 'HASH' } as never);
      passwords.verify.mockResolvedValue(false);

      await expect(
        service.loginWithPassword({ email: 'aditya@example.com', password: 'wrong' }, {}),
      ).rejects.toMatchObject({ errorCode: 'INVALID_CREDENTIALS' });
      expect(security.recordFailure).toHaveBeenCalled();
    });

    it('honours a temporary lock', async () => {
      security.assertNotLocked.mockRejectedValue({ errorCode: 'ACCOUNT_LOCKED' });
      await expect(
        service.loginWithPassword({ email: 'a@b.com', password: 'x' }, {}),
      ).rejects.toMatchObject({ errorCode: 'ACCOUNT_LOCKED' });
    });
  });

  describe('loginWithFirebaseMobile', () => {
    it('verifies the Firebase token, marks the mobile verified and issues tokens', async () => {
      firebase.verifyIdToken.mockResolvedValue({ phoneNumber: '+15551234567', uid: 'f-uid' });
      users.findByMobile.mockResolvedValue(makeIdentity({ mobileVerifiedAt: null }));
      const result = await service.loginWithFirebaseMobile('mock-token', {});
      expect(firebase.verifyIdToken).toHaveBeenCalledWith('mock-token');
      expect(users.markMobileVerified).toHaveBeenCalledWith('u1');
      expect(result.tokens.refreshToken).toBe('r');
    });
  });

  describe('refresh', () => {
    it('rotates for an active user', async () => {
      users.findById.mockResolvedValue(makeIdentity());
      const tokens = await service.refresh('u1', 's1', 'refresh', {});
      expect(sessions.refresh).toHaveBeenCalledWith('u1', 's1', 'refresh', expect.anything(), {});
      expect(tokens.accessToken).toBe('a');
    });
  });

  describe('changePassword', () => {
    it('changes the password when the current one matches', async () => {
      repo.getCredential.mockResolvedValue({ passwordHash: 'OLD' } as never);
      passwords.verify.mockResolvedValue(true);
      await service.changePassword('u1', 'old', 'N3w@Str0ng');
      expect(repo.upsertCredential).toHaveBeenCalledWith('u1', 'HASH');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'user.password_changed' }),
      );
    });

    it('throws when the current password is wrong', async () => {
      repo.getCredential.mockResolvedValue({ passwordHash: 'OLD' } as never);
      passwords.verify.mockResolvedValue(false);
      await expect(service.changePassword('u1', 'bad', 'N3w@Str0ng')).rejects.toMatchObject({
        errorCode: 'INVALID_CREDENTIALS',
      });
    });
  });

  describe('staffLogin', () => {
    function buildService(overrides: {
      deviceBinding?: jest.Mocked<
        Pick<ModeratorDeviceBindingService, 'assertSingleDeviceByIdentifier' | 'requestDeviceChange'>
      >;
      staffIpAllowlist?: jest.Mocked<Pick<StaffIpAllowlistService, 'isIpAllowed'>>;
    }): AuthService {
      const config = { get: () => ({ passwordResetTtlSeconds: 900 }) } as unknown as ConfigService;
      return new AuthService(
        users,
        bus,
        social,
        otp,
        sessions as unknown as ISessionService,
        repo,
        passwords as unknown as PasswordService,
        security as unknown as LoginSecurityService,
        firebase as unknown as FirebaseService,
        config,
        roleSource,
        undefined,
        overrides.deviceBinding as unknown as ModeratorDeviceBindingService | undefined,
        overrides.staffIpAllowlist as unknown as StaffIpAllowlistService | undefined,
        undefined,
      );
    }

    beforeEach(() => {
      users.findByEmail.mockResolvedValue(makeIdentity({ id: 'mod1' }));
      repo.getCredential.mockResolvedValue({ passwordHash: 'HASH' } as never);
      passwords.verify.mockResolvedValue(true);
      roleSource.getRoleNames.mockResolvedValue(['MODERATOR']);
    });

    it('files a device-change request and rejects with DEVICE_CHANGE_PENDING on an unbound device', async () => {
      const deviceBinding = {
        assertSingleDeviceByIdentifier: jest
          .fn()
          .mockRejectedValue(new ConflictException('Moderators are restricted to one active device.')),
        requestDeviceChange: jest.fn().mockResolvedValue({ id: 'req1' }),
      };
      const service = buildService({ deviceBinding });

      await expect(
        service.staffLogin(
          { email: 'mod@example.com', password: 'Str0ng@Pass', deviceIdentifier: 'device-new' },
          {},
        ),
      ).rejects.toMatchObject({ errorCode: 'DEVICE_CHANGE_PENDING' });

      expect(deviceBinding.requestDeviceChange).toHaveBeenCalledWith(
        expect.objectContaining({
          moderatorId: 'mod1',
          newDeviceInfo: expect.objectContaining({ deviceIdentifier: 'device-new' }),
        }),
      );
    });

    it('does not file a second request when one is already pending', async () => {
      const deviceBinding = {
        assertSingleDeviceByIdentifier: jest
          .fn()
          .mockRejectedValue(new ConflictException('Moderators are restricted to one active device.')),
        requestDeviceChange: jest
          .fn()
          .mockRejectedValue(new ConflictException('A device change request is already pending review.')),
      };
      const service = buildService({ deviceBinding });

      await expect(
        service.staffLogin(
          { email: 'mod@example.com', password: 'Str0ng@Pass', deviceIdentifier: 'device-new' },
          {},
        ),
      ).rejects.toMatchObject({ errorCode: 'DEVICE_CHANGE_PENDING' });

      expect(deviceBinding.requestDeviceChange).toHaveBeenCalledTimes(1);
    });

    it('rejects a disallowed IP with STAFF_IP_NOT_ALLOWED, distinct from a non-staff role', async () => {
      const staffIpAllowlist = { isIpAllowed: jest.fn().mockResolvedValue(false) };
      const service = buildService({ staffIpAllowlist });

      await expect(
        service.staffLogin({ email: 'mod@example.com', password: 'Str0ng@Pass' }, { ip: '10.0.0.5' }),
      ).rejects.toMatchObject({ errorCode: 'STAFF_IP_NOT_ALLOWED' });
    });
  });
});
