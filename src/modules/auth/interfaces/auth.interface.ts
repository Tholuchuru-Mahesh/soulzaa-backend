import type { SocialProvider } from './social-identity-verifier.interface';
import type { UserIdentity } from 'src/modules/users/interfaces/users.service.interface';
import type {
  AuthTokens,
  DeviceInfo,
  SessionContext,
} from 'src/modules/session/interfaces/session.interface';

/**
 * Public contract for the auth module — the surface other modules may depend on
 * (this token/interface or the EVENT_BUS). Concrete services, repositories and
 * entities stay private. HTTP clients go through AuthController; other modules
 * that need programmatic auth operations resolve AUTH_SERVICE.
 */
export const AUTH_SERVICE = Symbol('AUTH_SERVICE');

// Session-related shapes are owned by the session module; re-exported here so
// existing auth call sites keep importing them from the auth interface.
export type { AuthTokens, DeviceInfo };

/** Per-request context threaded into flows for auditing + session binding. */
export type AuthContext = SessionContext;

/** Standard result of a successful authentication. */
export interface AuthResult {
  user: UserIdentity;
  tokens: AuthTokens;
  isNewUser: boolean;
}

export interface IAuthService {
  register(input: RegisterCommand, ctx: AuthContext): Promise<AuthResult>;
  loginWithPassword(input: PasswordLoginCommand, ctx: AuthContext): Promise<AuthResult>;
  loginWithMobileOtp(input: MobileOtpLoginCommand, ctx: AuthContext): Promise<AuthResult>;
  loginWithFirebaseMobile(idToken: string, ctx: AuthContext): Promise<AuthResult>;
  loginWithSocial(input: SocialLoginCommand, ctx: AuthContext): Promise<AuthResult>;
  /**
   * Official Portal login: validates credentials AND asserts the user holds the
   * OFFICIAL role. Returns the same AuthResult as standard login so the Flutter
   * client can store tokens and navigate to the dashboard.
   */
  loginOfficialPortal(input: PasswordLoginCommand, ctx: AuthContext): Promise<AuthResult>;
  refresh(
    userId: string,
    sessionId: string,
    presentedToken: string,
    ctx: AuthContext,
  ): Promise<AuthTokens>;
  logout(userId: string, sessionId: string): Promise<void>;
  logoutAllDevices(userId: string): Promise<void>;
  verifyEmail(input: OtpVerifyCommand): Promise<void>;
  verifyMobile(input: OtpVerifyCommand): Promise<void>;
  forgotPassword(identifier: string): Promise<void>;
  resetPassword(token: string, newPassword: string): Promise<void>;
  changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void>;
  /** Current account identity for the authenticated user (read model). */
  me(userId: string): Promise<UserIdentity>;
}

// ---- Command shapes (query/command separation; DTOs map onto these) ----

/**
 * Sign-up asks for an email and a password only. Everything else is optional
 * because the profile-completion gate collects it after the first login — see
 * `UserIdentity.isProfileComplete` in the client. A caller that already has the
 * full details (the older multi-step form) may still supply them.
 */
export interface RegisterCommand {
  /**
   * Required by the public sign-up DTO. Optional here because internal callers
   * (admin/moderator provisioning) create accounts from a username + mobile and
   * may have no address to give.
   */
  email?: string;
  password: string;
  fullName?: string;
  username?: string;
  mobile?: string;
  gender?: 'MALE' | 'FEMALE' | 'OTHER';
  dateOfBirth?: string; // ISO date
  country?: string;
  state?: string;
  city?: string;
  preferredLanguage?: string;
}

export interface PasswordLoginCommand {
  email: string;
  password: string;
}

export interface MobileOtpLoginCommand {
  mobile: string;
  code: string;
}

export interface SocialLoginCommand {
  provider: SocialProvider;
  /**
   * The provider credential. An ID token for Google/Apple, an access token for
   * Facebook — see [ISocialIdentityVerifier]. Named `idToken` to match the
   * wire field shipped clients already send.
   */
  idToken: string;
}

export interface OtpVerifyCommand {
  destination: string;
  code: string;
}
