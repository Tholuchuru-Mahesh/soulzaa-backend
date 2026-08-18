import { Injectable } from '@nestjs/common';
import type {
  ISocialIdentityVerifier,
  SocialIdentity,
  SocialProvider,
} from '../../interfaces/social-identity-verifier.interface';
import { AppleVerifier } from './apple.verifier';
import { FacebookVerifier } from './facebook.verifier';
import { GoogleVerifier } from './google.verifier';

/**
 * Dispatches to the correct provider verifier. Bound to SOCIAL_VERIFIER so
 * AuthService depends only on the ISocialIdentityVerifier interface — adding a
 * provider is a change here, not in the auth flow.
 */
@Injectable()
export class SocialVerifierRegistry implements ISocialIdentityVerifier {
  constructor(
    private readonly google: GoogleVerifier,
    private readonly apple: AppleVerifier,
    private readonly facebook: FacebookVerifier,
  ) {}

  verify(provider: SocialProvider, credential: string): Promise<SocialIdentity> {
    switch (provider) {
      case 'GOOGLE':
        return this.google.verify(credential);
      case 'APPLE':
        return this.apple.verify(credential);
      case 'FACEBOOK':
        // An access token, not an ID token — see FacebookVerifier.
        return this.facebook.verify(credential);
    }
  }
}
