import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthProviderType } from '@prisma/client';
import { OAuth2Client } from 'google-auth-library';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { SocialIdentity } from '../../interfaces/social-identity-verifier.interface';

/**
 * Verifies Google ID tokens server-side (signature, issuer, audience, expiry)
 * via google-auth-library. Allowed audiences come from GOOGLE_CLIENT_IDS; an
 * empty list disables Google login.
 */
@Injectable()
export class GoogleVerifier {
  private readonly logger = new Logger(GoogleVerifier.name);
  private readonly client = new OAuth2Client();
  private readonly audiences: string[];

  constructor(config: ConfigService) {
    this.audiences = config.get('social', { infer: true })!.googleClientIds;
  }

  async verify(idToken: string): Promise<SocialIdentity> {
    if (this.audiences.length === 0) {
      throw new BusinessException(
        ERROR_CODES.INVALID_SOCIAL_TOKEN,
        'Google login is not configured',
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.audiences });
      const payload = ticket.getPayload();
      if (!payload?.sub) throw new Error('Missing subject');
      return {
        provider: AuthProviderType.GOOGLE,
        providerUserId: payload.sub,
        email: payload.email ?? null,
        emailVerified: payload.email_verified ?? false,
        name: payload.name ?? null,
      };
    } catch (err) {
      this.logger.warn(`Google token verification failed: ${(err as Error).message}`);
      throw new BusinessException(
        ERROR_CODES.INVALID_SOCIAL_TOKEN,
        'Invalid Google token',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
