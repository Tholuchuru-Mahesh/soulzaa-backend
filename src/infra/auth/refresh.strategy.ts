import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy, type JwtFromRequestFunction } from 'passport-jwt';

/** Pull the refresh token from a body `refreshToken` field (fallback to the header). */
const fromBody = (req: Request): string | null => {
  const token = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  return typeof token === 'string' ? token : null;
};

/** Authorization: Bearer <refresh>, else body.refreshToken. */
export const refreshTokenExtractor: JwtFromRequestFunction = ExtractJwt.fromExtractors([
  ExtractJwt.fromAuthHeaderAsBearerToken(),
  fromBody,
]);

export interface RefreshTokenUser {
  id: string;
  /** Session id from the refresh claim — the auth domain rotates this session. */
  sid: string;
  refreshToken: string;
}

/**
 * Validates a refresh-token signature and exposes the raw token on
 * `request.user` so a later refresh endpoint can rotate/revoke it. Signature
 * only — revocation/rotation checks belong to the auth domain module.
 */
@Injectable()
export class RefreshTokenStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: refreshTokenExtractor,
      ignoreExpiration: false,
      secretOrKey: config.get('jwt', { infer: true })!.refreshSecret,
      passReqToCallback: true,
    });
  }

  validate(req: Request, payload: { sub: string; sid: string }): RefreshTokenUser {
    const refreshToken = refreshTokenExtractor(req);
    if (!refreshToken) throw new UnauthorizedException('Missing refresh token');
    return { id: payload.sub, sid: payload.sid, refreshToken };
  }
}
