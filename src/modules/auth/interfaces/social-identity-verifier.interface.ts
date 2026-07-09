import type { AuthProviderType } from '@prisma/client';

export const SOCIAL_VERIFIER = Symbol('SOCIAL_VERIFIER');

/** The verified identity extracted from a provider ID token. */
export interface SocialIdentity {
  provider: AuthProviderType;
  /** Stable provider user id (the token `sub`). */
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/**
 * Verifies a provider (Google/Apple) ID token server-side and returns the
 * trusted identity. Implementations validate signature, issuer, audience and
 * expiry. This interface is the seam that keeps provider SDKs out of the auth
 * service and makes social login unit-testable.
 */
export interface ISocialIdentityVerifier {
  verify(provider: 'GOOGLE' | 'APPLE', idToken: string): Promise<SocialIdentity>;
}
