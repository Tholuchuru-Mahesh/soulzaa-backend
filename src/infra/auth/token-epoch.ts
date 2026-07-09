/**
 * Per-user "token epoch" stored in Redis. The current epoch is embedded in
 * every access token as the `tv` claim; force-logout-all bumps it so all
 * previously-issued access tokens fail the JwtStrategy check immediately
 * (refresh tokens are killed separately by revoking their sessions).
 *
 * Shared between infra (JwtStrategy, which reads it) and the auth domain's
 * SessionService (which bumps it) so the key convention lives in one place
 * without infra depending on a domain module.
 */
export const authTokenEpochKey = (userId: string): string => `auth:tv:${userId}`;
