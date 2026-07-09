import { Injectable } from '@nestjs/common';
import type {
  ISocialIdentityVerifier,
  SocialIdentity,
} from '../../interfaces/social-identity-verifier.interface';
import { AppleVerifier } from './apple.verifier';
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
  ) {}

  verify(provider: 'GOOGLE' | 'APPLE', idToken: string): Promise<SocialIdentity> {
    return provider === 'GOOGLE' ? this.google.verify(idToken) : this.apple.verify(idToken);
  }
}
