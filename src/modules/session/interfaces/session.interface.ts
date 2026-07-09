import type { DevicePlatform } from '@prisma/client';
import type { PlatformRole } from 'src/common/constants';
import type { TokenPair } from 'src/infra/auth/token.service';
import type { DeviceInfo } from 'src/modules/device/interfaces/device.interface';

/**
 * Public contract for the session module — the ONLY surface other modules (auth,
 * admin) may depend on. Internals (service, manager, repository, listeners) stay
 * private. Auth resolves SESSION_SERVICE to mint/rotate/revoke sessions; devices
 * live in the device module (referenced via DEVICE_SERVICE).
 */
export const SESSION_SERVICE = Symbol('SESSION_SERVICE');

// Device fingerprint is owned by the device module; re-exported so existing
// auth imports (`DeviceInfo` from the session interface) keep resolving.
export type { DeviceInfo };

/** Per-user claims embedded into the access token when a session is minted. */
export interface SessionClaims {
  userId: string;
  roles: PlatformRole[];
  isGuest: boolean;
}

/** Per-request context threaded through session operations (audit + hijack). */
export interface SessionContext {
  ip?: string;
  userAgent?: string;
  device?: DeviceInfo;
}

/** Access + refresh pair plus the token type, returned to clients. */
export interface AuthTokens extends TokenPair {
  tokenType: 'Bearer';
}

/** A read model of an active session for the "my devices" listing. */
export interface SessionView {
  sessionId: string;
  deviceId: string | null;
  platform: DevicePlatform | null;
  ip: string | null;
  userAgent: string | null;
  trusted: boolean;
  current: boolean;
  lastActivityAt: Date;
  createdAt: Date;
  expiresAt: Date;
}

export interface ISessionService {
  /** Mint a session (enforcing the concurrent limit) and return the token pair. */
  createSession(
    claims: SessionClaims,
    ctx: SessionContext,
  ): Promise<{ sessionId: string; tokens: AuthTokens }>;
  /**
   * Rotate a refresh token (reuse + hijack detection); returns a fresh pair.
   * Claims are supplied by the caller (auth loads the fresh user) so the session
   * module stays decoupled from the users module.
   */
  refresh(
    userId: string,
    sessionId: string,
    presentedToken: string,
    claims: SessionClaims,
    ctx: SessionContext,
  ): Promise<AuthTokens>;
  /** Revoke the current session (logout current device). */
  logoutCurrent(userId: string, sessionId: string, ctx?: SessionContext): Promise<void>;
  /** Revoke every session for a user (logout all devices) + bump the token epoch. */
  logoutAll(userId: string): Promise<void>;
  /** List a user's active sessions (marking the caller's current one). */
  listUserSessions(userId: string, currentSessionId?: string): Promise<SessionView[]>;
  /** Revoke one specific session, verifying it belongs to the user. */
  revoke(userId: string, sessionId: string): Promise<void>;
  /** Admin-triggered forced logout of another user (all sessions). */
  adminForceLogout(targetUserId: string, actorId: string): Promise<void>;
  /** Mark / unmark the device behind a session as trusted. */
  trustDevice(userId: string, sessionId: string, trusted: boolean): Promise<void>;
}
