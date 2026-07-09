import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthProviderType } from '@prisma/client';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { SocialIdentity } from '../../interfaces/social-identity-verifier.interface';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

/**
 * Verifies Apple ID tokens using Apple's published JWKS (jose), checking
 * signature, issuer and audience. Allowed audiences come from APPLE_CLIENT_IDS;
 * an empty list disables Apple login.
 */
@Injectable()
export class AppleVerifier {
  private readonly logger = new Logger(AppleVerifier.name);
  private readonly jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  private readonly audiences: string[];
  private readonly issuer: string;

  constructor(config: ConfigService) {
    const social = config.get('social', { infer: true })!;
    this.audiences = social.appleClientIds;
    this.issuer = social.appleIssuer;
  }

  async verify(idToken: string): Promise<SocialIdentity> {
    if (this.audiences.length === 0) {
      throw new BusinessException(
        ERROR_CODES.INVALID_SOCIAL_TOKEN,
        'Apple login is not configured',
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      const { payload } = await jwtVerify(idToken, this.jwks, {
        issuer: this.issuer,
        audience: this.audiences,
      });
      if (!payload.sub) throw new Error('Missing subject');
      const emailVerified = payload.email_verified;
      return {
        provider: AuthProviderType.APPLE,
        providerUserId: payload.sub,
        email: (payload.email as string | undefined) ?? null,
        emailVerified: emailVerified === true || emailVerified === 'true',
        name: null, // Apple only returns the name on first consent, out of band.
      };
    } catch (err) {
      this.logger.warn(`Apple token verification failed: ${(err as Error).message}`);
      throw new BusinessException(
        ERROR_CODES.INVALID_SOCIAL_TOKEN,
        'Invalid Apple token',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
