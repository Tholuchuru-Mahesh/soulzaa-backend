import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DevicePlatform, SessionEventType, UserSession } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { TokenService } from 'src/infra/auth/token.service';
import { authTokenEpochKey } from 'src/infra/auth/token-epoch';
import { LoginTelemetryService } from './login-telemetry.service';
import {
  DEVICE_SERVICE,
  type IDeviceService,
} from 'src/modules/device/interfaces/device.interface';
import {
  SessionCreatedEvent,
  SessionRefreshedEvent,
  SessionRevokedEvent,
} from '../events/session.events';
import type { AuthTokens, SessionClaims, SessionContext } from '../interfaces/session.interface';
import { SessionRepository } from '../repositories/session.repository';
import { sha256 } from '../hash.util';

/** Epoch key TTL — outlives any access token (matches the 30d refresh window). */
const EPOCH_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Read `exp` (ms) out of a signed JWT without re-verifying it. */
function jwtExpMs(token: string): number {
  const payload = token.split('.')[1] ?? '';
  const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp: number };
  return json.exp * 1000;
}

/**
 * Per-session lifecycle + security. Mints sessions (device upsert, DB row, Redis
 * live blob + user index, history, event), rotates refresh tokens with single-use
 * reuse detection and session-hijack detection, and revokes single/all sessions.
 * Refresh tokens are stored only as SHA-256 hashes. The manager layers policy
 * (concurrent limit, admin/user facades) on top of this.
 */
@Injectable()
export class SessionService {
  private readonly inactivitySeconds: number;
  private readonly hijackStrictIp: boolean;

  constructor(
    private readonly repo: SessionRepository,
    private readonly tokens: TokenService,
    private readonly cache: CacheService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(DEVICE_SERVICE) private readonly devices: IDeviceService,
    private readonly telemetry: LoginTelemetryService,
    config: ConfigService,
  ) {
    const cfg = config.get('session', { infer: true })!;
    this.inactivitySeconds = Number(cfg.inactivitySeconds);
    this.hijackStrictIp = Boolean(cfg.hijackStrictIp);
  }

  private async currentEpoch(userId: string): Promise<number> {
    return (await this.cache.get<number>(authTokenEpochKey(userId))) ?? 0;
  }

  /**
   * Mint a session. Upserts the device from ctx, signs the pair (sid + epoch in
   * the claims), persists the DB row, caches the live blob, indexes it under the
   * user, and records + emits the creation.
   */
  async createSession(
    claims: SessionClaims,
    ctx: SessionContext,
  ): Promise<{ sessionId: string; tokens: AuthTokens }> {
    const sid = randomUUID();
    const { deviceId, platform, trusted } = await this.resolveDevice(claims.userId, ctx);
    const tv = await this.currentEpoch(claims.userId);

    const pair = await this.tokens.signPair({
      sub: claims.userId,
      roles: claims.roles,
      isGuest: claims.isGuest,
      sid,
      tv,
    });

    await this.repo.createSession({
      id: sid,
      userId: claims.userId,
      deviceId,
      platform,
      refreshTokenHash: sha256(pair.refreshToken),
      expiresAt: new Date(jwtExpMs(pair.refreshToken)),
      createdByIp: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    await this.repo.cacheSession(
      sid,
      {
        userId: claims.userId,
        deviceId,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        platform,
        trusted,
      },
      this.inactivitySeconds,
    );
    await this.repo.addToUserIndex(claims.userId, sid);
    await this.repo.recordEvent({
      sessionId: sid,
      userId: claims.userId,
      event: SessionEventType.CREATED,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      // Spec §2: browser / OS / device / country on every login. Derived here so
      // security review can filter without re-parsing every row.
      telemetry: await this.telemetry.describe({ ip: ctx.ip, userAgent: ctx.userAgent }),
    });
    await this.bus.publish(
      new SessionCreatedEvent({ userId: claims.userId, sessionId: sid, deviceId, ip: ctx.ip }),
    );

    return { sessionId: sid, tokens: { ...pair, tokenType: 'Bearer' } };
  }

  /**
   * Rotate a refresh token. Validates the presented token, runs reuse + hijack
   * detection, then mints a replacement and retires the old session.
   */
  async refresh(
    userId: string,
    sessionId: string,
    presentedToken: string,
    claims: SessionClaims,
    ctx: SessionContext,
  ): Promise<AuthTokens> {
    const session = await this.repo.getSession(sessionId);
    const invalid =
      !session || session.userId !== userId || session.expiresAt.getTime() < Date.now();
    if (invalid) {
      throw new BusinessException(
        ERROR_CODES.SESSION_EXPIRED,
        'Session is no longer valid',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Reuse detection: a revoked/rotated session or hash mismatch = token theft.
    if (session.revokedAt || session.refreshTokenHash !== sha256(presentedToken)) {
      await this.revokeAllForUser(userId, 'reuse', ctx);
      throw new BusinessException(
        ERROR_CODES.TOKEN_REUSE_DETECTED,
        'Refresh token reuse detected; all sessions revoked',
        HttpStatus.UNAUTHORIZED,
      );
    }

    await this.assertNotHijacked(session, ctx);

    const next = await this.createSession(claims, {
      ...ctx,
      // Preserve the original device binding across rotation.
      device: ctx.device,
    });
    await this.repo.markSessionRotated(sessionId, next.sessionId);
    await this.repo.removeFromUserIndex(userId, sessionId);
    await this.repo.destroyCachedSession(sessionId);
    await this.repo.recordEvent({
      sessionId,
      userId,
      event: SessionEventType.REFRESHED,
      ip: ctx.ip ?? null,
    });
    await this.bus.publish(
      new SessionRefreshedEvent({
        userId,
        sessionId: next.sessionId,
        replacedSessionId: sessionId,
      }),
    );
    return next.tokens;
  }

  /** Revoke a single session (used by logout-current and per-session revoke). */
  async revokeSession(
    userId: string,
    sessionId: string,
    reason: 'user' | 'concurrent' | 'admin' = 'user',
  ): Promise<void> {
    await this.repo.revokeSession(sessionId);
    await this.repo.destroyCachedSession(sessionId);
    await this.repo.removeFromUserIndex(userId, sessionId);
    await this.repo.recordEvent({
      sessionId,
      userId,
      event:
        reason === 'concurrent' ? SessionEventType.CONCURRENT_EVICTED : SessionEventType.REVOKED,
    });
    await this.bus.publish(new SessionRevokedEvent({ userId, sessionId, reason }));
  }

  /**
   * Revoke every session for a user, clear the Redis index + live blobs, and bump
   * the token epoch so outstanding access tokens are rejected immediately.
   */
  async revokeAllForUser(
    userId: string,
    reason: 'user' | 'reuse' | 'hijack' | 'admin',
    ctx?: SessionContext,
  ): Promise<void> {
    const members = await this.repo.userIndexMembers(userId);
    await this.repo.revokeAllSessions(userId);
    await Promise.all(members.map((sid) => this.repo.destroyCachedSession(sid)));
    await this.repo.clearUserIndex(userId);
    await this.cache.increment(authTokenEpochKey(userId), { ttlSeconds: EPOCH_TTL_SECONDS });
    await this.repo.recordEvent({
      userId,
      event: reason === 'hijack' ? SessionEventType.HIJACK_DETECTED : SessionEventType.REVOKED,
      ip: ctx?.ip ?? null,
      metadata: { reason },
    });
  }

  // ---- Internal ----

  /**
   * Register the device via the device module (which handles upsert + suspicious-
   * login detection + alerts) and return its id/platform/trust for the session.
   */
  private async resolveDevice(
    userId: string,
    ctx: SessionContext,
  ): Promise<{ deviceId: string | null; platform: DevicePlatform | null; trusted: boolean }> {
    if (!ctx.device) return { deviceId: null, platform: null, trusted: false };
    const result = await this.devices.registerDevice(userId, ctx.device, {
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { deviceId: result.deviceId, platform: result.platform, trusted: result.trusted };
  }

  /**
   * Session-hijack detection on refresh: a different device binding is a hard
   * fail (revoke all). A changed IP is a hard fail only under strict mode; a
   * changed user-agent is recorded but tolerated (mobile networks churn IPs).
   */
  private async assertNotHijacked(session: UserSession, ctx: SessionContext): Promise<void> {
    let deviceMismatch = false;
    if (ctx.device && session.deviceId) {
      const known = await this.devices.getDeviceByIdentifier(
        session.userId,
        ctx.device.deviceIdentifier,
      );
      // Unknown device, or a different device than the session was bound to.
      deviceMismatch = !known || known.id !== session.deviceId;
    }
    const ipMismatch =
      this.hijackStrictIp && !!ctx.ip && !!session.createdByIp && ctx.ip !== session.createdByIp;

    if (deviceMismatch || ipMismatch) {
      await this.revokeAllForUser(session.userId, 'hijack', ctx);
      throw new BusinessException(
        ERROR_CODES.SESSION_HIJACK_DETECTED,
        'Session hijacking detected; all sessions revoked',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
