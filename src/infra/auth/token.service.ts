import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Permission, PlatformRole } from '../../common/constants';

export interface AccessTokenClaims {
  sub: string; // user id
  roles: PlatformRole[];
  permissions?: Permission[];
  /** Guest accounts are blocked from purchases (see GuestGuard). */
  isGuest?: boolean;
  /** Session id this token was minted under (matches UserSession.id). */
  sid?: string;
  /** Per-user token epoch — bumped on force-logout-all to invalidate live tokens. */
  tv?: number;
  [key: string]: unknown;
}

export interface RefreshTokenClaims {
  sub: string;
  /** Session id — binds the refresh token to a rotatable UserSession row. */
  sid: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Sign/verify plumbing for access & refresh tokens. The auth *domain* module
 * (later) owns the login/refresh flows and calls into this. Kept in infra so
 * guards/strategies can depend on it without touching business logic.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    const jwtCfg = this.config.get('jwt', { infer: true })!;
    return this.jwt.signAsync(claims, {
      secret: jwtCfg.accessSecret,
      expiresIn: jwtCfg.accessTtl,
    });
  }

  async signRefreshToken(claims: RefreshTokenClaims): Promise<string> {
    const jwtCfg = this.config.get('jwt', { infer: true })!;
    return this.jwt.signAsync(claims, {
      secret: jwtCfg.refreshSecret,
      expiresIn: jwtCfg.refreshTtl,
    });
  }

  /**
   * Sign an access+refresh pair for a session. `sid` binds both tokens to a
   * UserSession row so the refresh token can be rotated/revoked; the auth
   * domain module owns creating that session and storing the refresh hash.
   */
  async signPair(claims: AccessTokenClaims & { sid: string }): Promise<TokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      this.signAccessToken(claims),
      this.signRefreshToken({ sub: claims.sub, sid: claims.sid }),
    ]);
    return { accessToken, refreshToken };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const jwtCfg = this.config.get('jwt', { infer: true })!;
    return this.jwt.verifyAsync<AccessTokenClaims>(token, { secret: jwtCfg.accessSecret });
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
    const jwtCfg = this.config.get('jwt', { infer: true })!;
    return this.jwt.verifyAsync<RefreshTokenClaims>(token, { secret: jwtCfg.refreshSecret });
  }
}
