import {
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthProviderType, OtpPurpose } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PLATFORM_ROLES, type PlatformRole } from 'src/common/constants';
import { ROLE_SOURCE, type IRoleSource } from 'src/common/interfaces/role-source.interface';
import { PasswordService } from 'src/infra/auth/password.service';
import { generateUsernameFromEmail } from './username-generator';
import {
  USERS_SERVICE,
  type IUsersService,
  type UserIdentity,
} from 'src/modules/users/interfaces/users.service.interface';
import { OTP_SERVICE, type IOtpService } from 'src/modules/otp/interfaces/otp.interface';
import {
  UserEmailVerifiedEvent,
  UserLoggedInEvent,
  UserLoggedOutEvent,
  UserMobileVerifiedEvent,
  UserPasswordChangedEvent,
  UserRegisteredEvent,
  type AuthMethod,
} from '../events/auth.events';
import {
  type AuthContext,
  type AuthResult,
  type AuthTokens,
  type IAuthService,
  type OtpVerifyCommand,
  type PasswordLoginCommand,
  type RegisterCommand,
  type SocialLoginCommand,
} from '../interfaces/auth.interface';
import {
  SOCIAL_VERIFIER,
  type ISocialIdentityVerifier,
} from '../interfaces/social-identity-verifier.interface';
import {
  SESSION_SERVICE,
  type ISessionService,
  type SessionClaims,
} from 'src/modules/session/interfaces/session.interface';
import { AuthRepository } from '../repositories/auth.repository';
import { LoginSecurityService } from './login-security.service';
import { FirebaseService } from './firebase.service';
import { randomToken, sha256 } from './hash.util';
import { Admin2faService } from 'src/modules/admin-identity/services/admin-2fa.service';
import { ModeratorDeviceBindingService } from 'src/modules/device/services/moderator-device-binding.service';
import { StaffIpAllowlistService } from 'src/modules/device/services/staff-ip-allowlist.service';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';

/**
 * Roles that make an account "staff" — must log in via `staffLogin` only,
 * never the consumer `loginWithPassword` (moderator accounts hold both USER
 * and MODERATOR, so their credentials would otherwise work for either app).
 * Kept as one list so `loginWithPassword`'s rejection and `staffLogin`'s
 * acceptance never drift apart.
 */
const STAFF_ROLES = [
  'MODERATOR',
  'ADMIN',
  'SUPER_ADMIN',
  'COUNTRY_MANAGER',
  'STATE_MANAGER',
  'REGIONAL_MANAGER',
  'COIN_SELLER',
  'AGENT',
  'FINANCE_MANAGER',
];

/**
 * Auth domain orchestrator. Owns the auth flows (register/login/refresh/logout/
 * verify/password) and coordinates the credential, session, OTP, and social
 * collaborators. Identity is read/written only through IUsersService; all
 * cross-module side effects go out as events on the EVENT_BUS. Command and
 * query paths are kept separate so the module is CQRS-ready without a bus.
 */
@Injectable()
export class AuthService implements IAuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly resetTtlSeconds: number;

  constructor(
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(SOCIAL_VERIFIER) private readonly social: ISocialIdentityVerifier,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    @Inject(SESSION_SERVICE) private readonly sessions: ISessionService,
    private readonly repo: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly security: LoginSecurityService,
    private readonly firebaseService: FirebaseService,
    config: ConfigService,
    @Inject(ROLE_SOURCE) private readonly roleSource: IRoleSource,
    @Optional() private readonly admin2fa?: Admin2faService,
    @Optional() private readonly deviceBinding?: ModeratorDeviceBindingService,
    @Optional() private readonly staffIpAllowlist?: StaffIpAllowlistService,
    @Optional() @Inject(NOTIFICATION_SERVICE) private readonly notifications?: INotificationService,
    @Optional() private readonly platformBans?: PlatformBanService,
  ) {
    this.resetTtlSeconds = Number(config.get('security', { infer: true })!.passwordResetTtlSeconds);
  }

  // ---- Registration ----

  async register(input: RegisterCommand, ctx: AuthContext): Promise<AuthResult> {
    // `username` is NOT NULL and unique but sign-up no longer asks for one, so
    // mint it from the address when the caller did not supply it.
    const username =
      input.username ??
      (await generateUsernameFromEmail(
        // No address to derive from (an internal caller that gave neither) still
        // yields a valid, unique name rather than failing the insert.
        input.email ?? '',
        async (candidate) => (await this.users.findByUsername(candidate)) !== null,
      ));

    const user = await this.users.createIdentity({
      username,
      email: input.email ?? null,
      mobile: input.mobile ?? null,
      fullName: input.fullName ?? null,
      gender: input.gender ?? null,
      dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
      country: input.country ?? null,
      state: input.state ?? null,
      city: input.city ?? null,
      preferredLanguage: input.preferredLanguage ?? null,
      isGuest: false,
    });

    const passwordHash = await this.passwords.hash(input.password);
    await this.repo.upsertCredential(user.id, passwordHash);
    await this.repo.ensureProviderMarker(user.id, AuthProviderType.PASSWORD);

    if (input.mobile) {
      await this.repo.ensureProviderMarker(user.id, AuthProviderType.MOBILE_OTP);
      // Kick off mobile verification; the client completes it via /auth/verify-mobile.
      await this.otp.generate({
        destination: input.mobile,
        purpose: OtpPurpose.MOBILE_VERIFY,
        userId: user.id,
      });
    }

    await this.bus.publish(
      new UserRegisteredEvent({
        userId: user.id,
        method: 'PASSWORD',
        isGuest: false,
        email: user.email,
        mobile: user.mobile,
      }),
    );

    return this.issue(user, ctx, 'PASSWORD', true);
  }

  // ---- Login ----

  async loginWithPassword(input: PasswordLoginCommand, ctx: AuthContext): Promise<AuthResult> {
    const identifier = (input.email || (input as any).username || '').toLowerCase();
    await this.security.assertNotLocked(identifier);

    let user = await this.users.findByEmail(identifier);
    if (!user) {
      user = await this.users.findByUsername(identifier);
    }
    const credential = user ? await this.repo.getCredential(user.id) : null;
    const ok =
      user !== null &&
      credential?.passwordHash != null &&
      (await this.passwords.verify(input.password, credential.passwordHash));

    if (!ok || !user) {
      await this.security.recordFailure(identifier);
      throw new BusinessException(
        ERROR_CODES.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Staff accounts (moderator and above) authenticate only through
    // `staffLogin` — never the consumer app, even though the same password
    // would otherwise verify (a moderator account also holds the USER role
    // for internal endpoint compatibility). Responds identically to a wrong
    // password rather than a distinct "staff account" error, so a consumer
    // login attempt can't be used to enumerate which emails are staff.
    const userRoles = await this.roleSource.getRoleNames(user.id);
    if (userRoles.some((role: string) => STAFF_ROLES.includes(role))) {
      await this.security.recordFailure(identifier, {
        userId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: 'STAFF_ACCOUNT_CONSUMER_LOGIN_BLOCKED',
      });
      throw new BusinessException(
        ERROR_CODES.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );
    }

    this.assertActive(user);
    await this.assertNotBanned(user);
    await this.security.recordSuccess(identifier);
    return this.issue(user, ctx, 'PASSWORD', false);
  }

  /**
   * Official Portal login — validates that the user exists and holds the OFFICIAL role
   * assigned by Super Admin.
   * If the account was provisioned by Super Admin without a password, sets their password
   * on first login. Otherwise verifies the entered password.
   */
  async loginOfficialPortal(input: PasswordLoginCommand, ctx: AuthContext): Promise<AuthResult> {
    const identifier = (input.email || (input as any).username || '').toLowerCase().trim();
    await this.security.assertNotLocked(identifier);

    let user = await this.users.findByEmail(identifier);
    if (!user) {
      user = await this.users.findByUsername(identifier);
    }

    if (!user) {
      await this.security.recordFailure(identifier);
      throw new BusinessException(
        ERROR_CODES.INVALID_CREDENTIALS,
        'No official account found with this email address. Please ensure Super Admin has assigned your role.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Assert the OFFICIAL role from the RBAC store or the User record
    const userRoles = await this.roleSource.getRoleNames(user.id);
    const hasOfficialRole =
      userRoles.includes('OFFICIAL') ||
      (user.roles && (user.roles as string[]).includes('OFFICIAL'));

    if (!hasOfficialRole) {
      await this.security.recordFailure(identifier);
      throw new BusinessException(
        ERROR_CODES.FORBIDDEN,
        'Access denied: This account has not been assigned the Official role by Super Admin.',
        HttpStatus.FORBIDDEN,
      );
    }

    const credential = await this.repo.getCredential(user.id);

    // If account was provisioned by Super Admin without a password yet, set their password on first login
    if (!credential || !credential.passwordHash) {
      const passwordHash = await this.passwords.hash(input.password);
      await this.repo.upsertCredential(user.id, passwordHash);
      await this.repo.ensureProviderMarker(user.id, AuthProviderType.PASSWORD);
    } else {
      const isPasswordValid = await this.passwords.verify(input.password, credential.passwordHash);
      if (!isPasswordValid) {
        await this.security.recordFailure(identifier);
        throw new BusinessException(
          ERROR_CODES.INVALID_CREDENTIALS,
          'Invalid password. Please check your credentials.',
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    this.assertActive(user);
    await this.security.recordSuccess(identifier);
    return this.issue(user, ctx, 'PASSWORD', false);
  }

  async staffLogin(
    input: PasswordLoginCommand & {
      totpCode?: string;
      deviceIdentifier?: string;
      deviceName?: string;
      platform?: string;
      osVersion?: string;
      appVersion?: string;
      identifier?: string;
    },
    ctx: AuthContext,
  ): Promise<AuthResult> {
    const identifier = (
      input.email ||
      (input as any).username ||
      (input as any).identifier ||
      ''
    ).toLowerCase();
    await this.security.assertNotLocked(identifier);

    let user = await this.users.findByEmail(identifier);
    if (!user) {
      user = await this.users.findByUsername(identifier);
    }
    const credential = user ? await this.repo.getCredential(user.id) : null;
    const ok =
      user !== null &&
      credential?.passwordHash != null &&
      (await this.passwords.verify(input.password, credential.passwordHash));

    if (!ok || !user) {
      await this.security.recordFailure(identifier, {
        userId: user?.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: 'INVALID_CREDENTIALS',
      });
      throw new BusinessException(
        ERROR_CODES.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );
    }

    this.assertActive(user);
    await this.assertNotBanned(user);

    // 1. Staff Role Assertion (Task 9)
    const userRoles = await this.roleSource.getRoleNames(user.id);
    const isStaff = userRoles.some((role: string) => STAFF_ROLES.includes(role));

    if (!isStaff) {
      await this.security.recordFailure(identifier, {
        userId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: 'NOT_STAFF_ROLE',
      });
      throw new BusinessException(
        ERROR_CODES.FORBIDDEN,
        'Access denied: Staff portal is restricted to authorized staff personnel.',
        HttpStatus.FORBIDDEN,
      );
    }

    // 2. 2FA TOTP Verification (Task 10)
    if (this.admin2fa) {
      const isEnrolled = await this.admin2fa.isEnrolled(user.id);
      if (isEnrolled) {
        if (!input.totpCode) {
          await this.security.recordFailure(identifier, {
            userId: user.id,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            reason: '2FA_CODE_REQUIRED',
          });
          throw new BusinessException(
            ERROR_CODES.UNAUTHORIZED,
            'Two-factor authentication code is required',
            HttpStatus.UNAUTHORIZED,
          );
        }
        try {
          await this.admin2fa.verify(user.id, input.totpCode);
        } catch (err) {
          await this.security.recordFailure(identifier, {
            userId: user.id,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            reason: '2FA_VERIFICATION_FAILED',
          });
          throw err;
        }
      }
    }

    // 3. Bound Device Verification (Task 11)
    if (this.deviceBinding && input.deviceIdentifier) {
      try {
        await this.deviceBinding.assertSingleDeviceByIdentifier(user.id, input.deviceIdentifier, {
          deviceName: input.deviceName,
          platform: input.platform,
          osVersion: input.osVersion,
          appVersion: input.appVersion,
        });
      } catch (err) {
        await this.security.recordFailure(identifier, {
          userId: user.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          reason: 'UNBOUND_DEVICE',
        });

        if (!(err instanceof ConflictException)) throw err;

        // The device is unrecognized. File a device-change request so an
        // admin has something to approve — the caller has no session yet
        // (this throw happens before `issue()`), so they cannot call the
        // authenticated `POST /moderator/device-change` endpoint themselves.
        try {
          await this.deviceBinding.requestDeviceChange({
            moderatorId: user.id,
            newDeviceInfo: {
              deviceIdentifier: input.deviceIdentifier,
              deviceName: input.deviceName,
              platform: input.platform,
              osVersion: input.osVersion,
              appVersion: input.appVersion,
            },
            reason: 'Automatic: rejected login from unbound device',
          });
        } catch (requestErr) {
          // A request is already pending from an earlier attempt — that is
          // the desired end state, not a new failure.
          if (!(requestErr instanceof ConflictException)) throw requestErr;
        }

        throw new BusinessException(
          ERROR_CODES.DEVICE_CHANGE_PENDING,
          "This device isn't recognized. A request has been sent for admin approval.",
          HttpStatus.CONFLICT,
        );
      }
    }

    await this.security.recordSuccess(identifier);

    // 5. Staff Login Alert (Gap B2)
    if (this.notifications) {
      void this.notifications.create({
        userId: user.id,
        type: 'SECURITY_NEW_LOGIN' as any,
        entityType: 'staff_session',
        data: {
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
          loginAt: new Date().toISOString(),
          isStaff: true,
        },
      });
    }

    return this.issue(user, ctx, 'PASSWORD', false);
  }

  async loginWithMobileOtp(
    input: { mobile: string; code: string },
    ctx: AuthContext,
  ): Promise<AuthResult> {
    const phoneNumber = input.mobile.trim();
    await this.security.assertNotLocked(phoneNumber);

    // 1. Verify OTP code
    await this.otp.verify({
      destination: phoneNumber,
      purpose: OtpPurpose.LOGIN,
      code: input.code,
    });

    let isNewUser = false;
    let user = await this.users.findByMobile(phoneNumber);
    if (!user && phoneNumber.startsWith('+')) {
      user = await this.users.findByMobile(phoneNumber.slice(1));
    }
    if (!user && !phoneNumber.startsWith('+')) {
      user = await this.users.findByMobile(`+${phoneNumber}`);
    }

    if (!user) {
      isNewUser = true;
      const username = await this.generateUsername(
        null,
        `User_${phoneNumber.replace(/\D/g, '').slice(-4)}`,
      );
      const defaultCountry = phoneNumber.startsWith('+91') ? 'India' : null;
      user = await this.users.createIdentity({
        username,
        mobile: phoneNumber,
        fullName: `User ${phoneNumber.slice(-4)}`,
        country: defaultCountry,
        isGuest: false,
      });
      await this.bus.publish(
        new UserRegisteredEvent({
          userId: user.id,
          method: AuthProviderType.MOBILE_OTP,
          isGuest: false,
          email: user.email,
          mobile: user.mobile,
        }),
      );
    }

    this.assertActive(user);
    await this.assertNotBanned(user);

    // A successful OTP login implicitly verifies the number.
    if (!user.mobileVerifiedAt) {
      await this.users.markMobileVerified(user.id);
      await this.repo.ensureProviderMarker(user.id, AuthProviderType.MOBILE_OTP);
    }

    await this.security.recordSuccess(phoneNumber);
    return this.issue(user, ctx, 'MOBILE_OTP', isNewUser);
  }

  async loginWithFirebaseMobile(idToken: string, ctx: AuthContext): Promise<AuthResult> {
    const verified = await this.firebaseService.verifyIdToken(idToken);
    const phoneNumber = verified.phoneNumber;

    let user = await this.users.findByMobile(phoneNumber);
    if (!user && phoneNumber.startsWith('+')) {
      user = await this.users.findByMobile(phoneNumber.slice(1));
    }

    if (!user) {
      const username = await this.generateUsername(
        null,
        `User_${phoneNumber.replace(/\D/g, '').slice(-4)}`,
      );
      const defaultCountry = phoneNumber.startsWith('+91') ? 'India' : null;
      user = await this.users.createIdentity({
        username,
        mobile: phoneNumber,
        fullName: `User ${phoneNumber.slice(-4)}`,
        country: defaultCountry,
        isGuest: false,
      });
      await this.bus.publish(
        new UserRegisteredEvent({
          userId: user.id,
          method: AuthProviderType.MOBILE_OTP,
          isGuest: false,
          email: user.email,
          mobile: user.mobile,
        }),
      );
    }
    this.assertActive(user);
    await this.assertNotBanned(user);

    // A successful Firebase OTP login implicitly verifies the number.
    if (!user.mobileVerifiedAt) {
      await this.users.markMobileVerified(user.id);
      await this.repo.ensureProviderMarker(user.id, AuthProviderType.MOBILE_OTP);
    }

    return this.issue(user, ctx, 'MOBILE_OTP', false);
  }

  async loginWithSocial(input: SocialLoginCommand, ctx: AuthContext): Promise<AuthResult> {
    const identity = await this.social.verify(input.provider, input.idToken);
    const providerType =
      input.provider === 'GOOGLE' ? AuthProviderType.GOOGLE : AuthProviderType.APPLE;

    // 1) Known provider identity → existing account.
    const existingLink = await this.repo.findProvider(providerType, identity.providerUserId);
    if (existingLink) {
      const user = await this.users.findById(existingLink.userId);
      if (!user) {
        throw new BusinessException(
          ERROR_CODES.NOT_FOUND,
          'Account not found',
          HttpStatus.NOT_FOUND,
        );
      }
      this.assertActive(user);
      await this.assertNotBanned(user);
      return this.issue(user, ctx, providerType, false);
    }

    // 2) Same verified email as an existing account → link the provider to it.
    if (identity.email && identity.emailVerified) {
      const byEmail = await this.users.findByEmail(identity.email);
      if (byEmail) {
        this.assertActive(byEmail);
        await this.assertNotBanned(byEmail);
        await this.repo.upsertProvider({
          userId: byEmail.id,
          provider: providerType,
          providerUserId: identity.providerUserId,
          email: identity.email,
        });
        return this.issue(byEmail, ctx, providerType, false);
      }
    }

    // 3) New account from the social identity (no profile logic here).
    const username = await this.generateUsername(identity.email, identity.name);
    const user = await this.users.createIdentity({
      username,
      email: identity.email,
      fullName: identity.name,
      isGuest: false,
    });
    if (identity.email && identity.emailVerified) await this.users.markEmailVerified(user.id);
    await this.repo.upsertProvider({
      userId: user.id,
      provider: providerType,
      providerUserId: identity.providerUserId,
      email: identity.email,
    });

    await this.bus.publish(
      new UserRegisteredEvent({
        userId: user.id,
        method: providerType,
        isGuest: false,
        email: user.email,
        mobile: user.mobile,
      }),
    );

    return this.issue(user, ctx, providerType, true);
  }

  // ---- Sessions ----

  async refresh(
    userId: string,
    sessionId: string,
    presentedToken: string,
    ctx: AuthContext,
  ): Promise<AuthTokens> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new BusinessException(
        ERROR_CODES.SESSION_EXPIRED,
        'Session is no longer valid',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.assertActive(user);
    // Deliberately NOT `assertNotBanned` here (unlike the login methods
    // above). Token refresh happens silently in the background of an
    // already-active session — any authenticated request can trigger one the
    // instant the access token expires. `PlatformBanService.banUser` already
    // ends an active session gracefully: it emits `platform-ban.account-banned`
    // over the user's own socket, which the client shows as a "Soulzaa
    // Official" notice before it logs itself out. Blocking refresh here raced
    // that flow — the very next background request's refresh would 403,
    // Dio's refresh-failure handling treats that identically to "the refresh
    // token was revoked," and force-clears the session and disconnects every
    // socket immediately, often before the graceful notice's socket event had
    // even arrived. New logins stay blocked (every method above this one
    // still calls `assertNotBanned`); only silently extending a session
    // that's already about to be torn down by the graceful path does not.
    return this.sessions.refresh(
      userId,
      sessionId,
      presentedToken,
      await this.claimsFor(user),
      ctx,
    );
  }

  async logout(userId: string, sessionId: string): Promise<void> {
    await this.sessions.logoutCurrent(userId, sessionId);
    await this.bus.publish(new UserLoggedOutEvent({ userId, sessionId, allDevices: false }));
  }

  async logoutAllDevices(userId: string): Promise<void> {
    await this.sessions.logoutAll(userId);
    await this.bus.publish(new UserLoggedOutEvent({ userId, sessionId: null, allDevices: true }));
  }

  // ---- Verification ----

  async verifyEmail(input: OtpVerifyCommand): Promise<void> {
    await this.otp.verify({
      destination: input.destination,
      purpose: OtpPurpose.EMAIL_VERIFY,
      code: input.code,
    });
    const user = await this.users.findByEmail(input.destination);
    if (!user) {
      throw new BusinessException(ERROR_CODES.NOT_FOUND, 'Account not found', HttpStatus.NOT_FOUND);
    }
    await this.users.markEmailVerified(user.id);
    await this.bus.publish(new UserEmailVerifiedEvent({ userId: user.id, email: user.email! }));
  }

  async verifyMobile(input: OtpVerifyCommand): Promise<void> {
    await this.otp.verify({
      destination: input.destination,
      purpose: OtpPurpose.MOBILE_VERIFY,
      code: input.code,
    });
    const user = await this.users.findByMobile(input.destination);
    if (!user) {
      throw new BusinessException(ERROR_CODES.NOT_FOUND, 'Account not found', HttpStatus.NOT_FOUND);
    }
    await this.users.markMobileVerified(user.id);
    await this.repo.ensureProviderMarker(user.id, AuthProviderType.MOBILE_OTP);
    await this.bus.publish(new UserMobileVerifiedEvent({ userId: user.id, mobile: user.mobile! }));
  }

  // ---- Password recovery / change ----

  async forgotPassword(identifier: string): Promise<void> {
    await this.security.enforceRateLimit(`forgot:${identifier.toLowerCase()}`, 3, 600);
    const user = identifier.includes('@')
      ? await this.users.findByEmail(identifier)
      : await this.users.findByMobile(identifier);
    // Do not leak account existence — always return success to the caller.
    if (!user) return;

    await this.repo.invalidateUserResetTokens(user.id);
    const token = randomToken();
    await this.repo.createPasswordResetToken({
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + this.resetTtlSeconds * 1000),
    });

    // Deliver the reset token. Password reset uses a single-use link token (not
    // an OTP code), so it goes out of band from the OTP module. TODO: route
    // through the notification module / a real mailer; logged in dev for now.
    this.logger.warn(`[DEV RESET] ${identifier}: ${token}`);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const record = await this.repo.findPasswordResetToken(sha256(token));
    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Invalid or expired reset token',
        HttpStatus.BAD_REQUEST,
      );
    }
    const consumed = await this.repo.consumePasswordResetToken(record.id);
    if (consumed.count === 0) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Reset token already used',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.repo.upsertCredential(record.userId, await this.passwords.hash(newPassword));
    // Recovering a password invalidates every existing session.
    await this.sessions.logoutAll(record.userId);
    // A successful recovery also clears any login lockout so the user can sign
    // back in immediately with the new password.
    const user = await this.users.findById(record.userId);
    if (user?.email) await this.security.recordSuccess(user.email);
    if (user?.mobile) await this.security.recordSuccess(user.mobile);
    await this.bus.publish(new UserPasswordChangedEvent({ userId: record.userId, viaReset: true }));
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const credential = await this.repo.getCredential(userId);
    const ok =
      credential?.passwordHash != null &&
      (await this.passwords.verify(currentPassword, credential.passwordHash));
    if (!ok) {
      throw new BusinessException(
        ERROR_CODES.INVALID_CREDENTIALS,
        'Current password is incorrect',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.repo.upsertCredential(userId, await this.passwords.hash(newPassword));
    await this.repo.ensureProviderMarker(userId, AuthProviderType.PASSWORD);
    await this.bus.publish(new UserPasswordChangedEvent({ userId, viaReset: false }));
  }

  // ---- Queries ----

  async me(userId: string): Promise<UserIdentity> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new BusinessException(ERROR_CODES.NOT_FOUND, 'Account not found', HttpStatus.NOT_FOUND);
    }
    const claims = await this.claimsFor(user);
    return {
      ...user,
      roles: claims.roles,
    };
  }

  // ---- Helpers ----

  /**
   * Mint a session and log the login event. Device upsert + binding now happen
   * inside the session module (from ctx.device), so auth just forwards context.
   */
  private async issue(
    user: UserIdentity,
    ctx: AuthContext,
    method: AuthMethod,
    isNewUser: boolean,
  ): Promise<AuthResult> {
    const claims = await this.claimsFor(user);
    const { sessionId, tokens } = await this.sessions.createSession(claims, ctx);
    await this.bus.publish(
      new UserLoggedInEvent({ userId: user.id, sessionId, method, deviceId: null, ip: ctx.ip }),
    );
    const userWithRoles: UserIdentity = {
      ...user,
      roles: claims.roles,
    };
    return { user: userWithRoles, tokens, isNewUser };
  }

  /**
   * Builds the session claims, taking roles from the RBAC store so a token
   * reflects assignments made through Super Admin role management. The legacy
   * `User.roles` column is used only when the account has no RBAC assignment
   * yet; guards resolve roles per-request regardless, so this claim is a
   * convenience projection rather than an authority.
   */
  private async claimsFor(user: UserIdentity): Promise<SessionClaims> {
    const assigned = (await this.roleSource.getRoleNames(user.id)).filter(
      (name): name is PlatformRole => (PLATFORM_ROLES as readonly string[]).includes(name),
    );
    const roles = assigned.length > 0 ? assigned : user.roles;
    return { userId: user.id, roles, isGuest: user.isGuest };
  }

  private assertActive(user: UserIdentity): void {
    if (user.status !== 'ACTIVE') {
      throw new BusinessException(
        ERROR_CODES.ACCOUNT_INACTIVE,
        'Account is not active',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async assertNotBanned(user: UserIdentity): Promise<void> {
    if (!this.platformBans) return;
    const ban = await this.platformBans.getActiveBan(user.id);
    if (ban) {
      throw new BusinessException(
        ERROR_CODES.ACCOUNT_BANNED,
        `Your account is banned until ${ban.expiresAt} for: ${ban.reason}`,
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** Derive a unique username from a social profile, falling back to random. */
  private async generateUsername(email: string | null, name: string | null): Promise<string> {
    const base = (email?.split('@')[0] ?? name ?? 'user')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 15)
      .padEnd(4, '0');
    for (let i = 0; i < 5; i++) {
      const candidate = i === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`;
      if (!(await this.users.isUsernameTaken(candidate))) return candidate;
    }
    return `${base}${randomToken(4)}`;
  }
}
