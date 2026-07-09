import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { CacheService } from '../redis/cache.service';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user';
import type { AccessTokenClaims } from './token.service';
import { authTokenEpochKey } from './token-epoch';

/**
 * Validates the access-token Bearer and maps claims → request.user.
 *
 * Beyond the signature check this enforces two Redis-backed guards owned by the
 * session domain (infra only knows the key conventions + TTL):
 *  - the per-user token epoch (`auth:tv:{userId}`): force-logout-all bumps it, so
 *    a token with a stale `tv` claim is rejected immediately.
 *  - the live session key (`session:{sid}`, via CacheService's session helpers):
 *    absent → the session was revoked or lapsed from inactivity → reject; present
 *    → slide its TTL (the inactivity window) so active use keeps it alive.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly inactivitySeconds: number;

  constructor(
    config: ConfigService,
    private readonly cache: CacheService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('jwt', { infer: true })!.accessSecret,
    });
    this.inactivitySeconds = Number(config.get('session', { infer: true })!.inactivitySeconds);
  }

  async validate(payload: AccessTokenClaims): Promise<AuthenticatedUser> {
    await this.assertCurrentEpoch(payload);
    await this.assertLiveSession(payload);
    return {
      ...payload,
      id: payload.sub,
      roles: payload.roles ?? [],
      permissions: payload.permissions ?? [],
      isGuest: payload.isGuest ?? false,
      sid: payload.sid,
    };
  }

  /** Reject tokens minted before the user's current epoch (force-logout-all). */
  private async assertCurrentEpoch(payload: AccessTokenClaims): Promise<void> {
    const current = await this.cache.get<number>(authTokenEpochKey(payload.sub));
    // No stored epoch → nothing has been force-revoked; token stands.
    if (current === null) return;
    if ((payload.tv ?? 0) < current) {
      throw new UnauthorizedException('Session has been revoked');
    }
  }

  /**
   * Enforce the live session (revoke immediacy + inactivity expiry). Tokens
   * without a `sid` (none are issued today) skip this. A present session has its
   * TTL slid forward so continued activity never lapses.
   */
  private async assertLiveSession(payload: AccessTokenClaims): Promise<void> {
    if (!payload.sid) return;
    const session = await this.cache.getSession(payload.sid);
    if (session === null) {
      throw new UnauthorizedException('Session is no longer active');
    }
    await this.cache.touchSession(payload.sid, this.inactivitySeconds);
  }
}
