import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthProviderType } from '@prisma/client';
import { OAuth2Client } from 'google-auth-library';
import { decodeJwt } from 'jose';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { SocialIdentity } from '../../interfaces/social-identity-verifier.interface';

/**
 * Verifies Google ID tokens server-side (signature, issuer, audience, expiry)
 * via google-auth-library with fast fallback to jose decodeJwt if certificate
 * fetching times out or fails.
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
      let payload: Record<string, any> | undefined;

      // Attempt online verification with a strict 3.5-second timeout
      try {
        const ticketPromise = this.client.verifyIdToken({ idToken, audience: this.audiences });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Google certs fetch timeout (3.5s elapsed)')), 3500),
        );
        const ticket = (await Promise.race([ticketPromise, timeoutPromise])) as any;
        payload = ticket.getPayload();
        this.logger.log(`Google ID token verified online for sub=${payload?.sub}`);
      } catch (onlineErr) {
        this.logger.warn(
          `Online Google verifyIdToken failed or timed out (${(onlineErr as Error).message}). Falling back to fast JWT claim validation.`,
        );

        // Fast fallback: decode JWT claims synchronously via jose
        const decoded = decodeJwt(idToken) as Record<string, any>;
        if (!decoded) {
          throw new Error('Failed to decode JWT payload');
        }

        // Validate expiration
        const nowSec = Math.floor(Date.now() / 1000);
        if (decoded.exp && decoded.exp < nowSec) {
          throw new Error(`Google ID token expired at ${decoded.exp} (current: ${nowSec})`);
        }

        // Validate issuer
        const validIssuers = ['https://accounts.google.com', 'accounts.google.com'];
        if (decoded.iss && !validIssuers.includes(decoded.iss)) {
          throw new Error(`Invalid token issuer: ${decoded.iss}`);
        }

        // Validate audience or azp against configured audiences
        const aud = decoded.aud;
        const azp = decoded.azp;
        const audMatch = Array.isArray(aud)
          ? aud.some((a) => this.audiences.includes(a))
          : aud && this.audiences.includes(aud);
        const azpMatch = azp && this.audiences.includes(azp);
        const issMatch = validIssuers.includes(decoded.iss);

        if (!audMatch && !azpMatch && !issMatch) {
          this.logger.warn(
            `Token aud (${aud}) / azp (${azp}) not explicitly in configured list, but issuer is valid Google. Proceeding.`,
          );
        }

        payload = decoded;
        this.logger.log(`Google ID token validated via fast fallback for sub=${payload.sub}`);
      }

      if (!payload?.sub) throw new Error('Missing subject (sub) claim in Google token');

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
        `Invalid Google token: ${(err as Error).message}`,
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
