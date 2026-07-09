import type { Permission, PlatformRole } from '../constants';

/**
 * Shape attached to `request.user` after JWT auth. The auth domain module
 * will populate this from access-token claims; guards and the @CurrentUser
 * decorator read it. `permissions` is optional (populated from a token claim
 * by later login logic) and consumed by PermissionsGuard.
 */
export interface AuthenticatedUser {
  id: string;
  roles: PlatformRole[];
  permissions?: Permission[];
  /** True for guest accounts — blocked from coin/VIP/room purchases (GuestGuard). */
  isGuest?: boolean;
  /** Session id (`sid`) the access token was minted under. */
  sid?: string;
  [key: string]: unknown;
}
