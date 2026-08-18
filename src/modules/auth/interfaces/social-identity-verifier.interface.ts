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

/** The providers social login accepts. */
export type SocialProvider = 'GOOGLE' | 'APPLE' | 'FACEBOOK';

/**
 * Verifies a provider credential server-side and returns the trusted identity.
 * Google and Apple send a signed ID token, validated offline for signature,
 * issuer, audience and expiry. Facebook has no such token — the client holds an
 * opaque access token, which its verifier checks by calling Facebook. Hence
 * `credential` rather than `idToken`: what the string *is* differs by provider,
 * and only the verifier needs to know.
 *
 * This interface is the seam that keeps provider SDKs out of the auth service
 * and makes social login unit-testable.
 */
export interface ISocialIdentityVerifier {
  verify(provider: SocialProvider, credential: string): Promise<SocialIdentity>;
}
