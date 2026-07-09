/**
 * Kept for backward-compatible imports. The real auth contract lives in
 * ./auth.interface (AUTH_SERVICE + IAuthService). Re-exported here so existing
 * `interfaces/auth.service.interface` import paths continue to resolve.
 */
export * from './auth.interface';
