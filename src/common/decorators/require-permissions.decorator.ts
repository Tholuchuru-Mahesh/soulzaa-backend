import { SetMetadata } from '@nestjs/common';
import { PERMISSIONS_KEY, type Permission } from '../constants';

/**
 * Restrict a route to callers holding ALL the given permissions (enforced by
 * the DB-backed RbacPermissionsGuard). SUPER_ADMIN bypasses via its wildcard
 * grant. e.g. @RequirePermissions('wallet:adjust').
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
