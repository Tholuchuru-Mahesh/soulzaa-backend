// Domain/shared constant groups.
export * from './api.constants';
export * from './pagination.constants';
export * from './header.constants';
export * from './cache.constants';
export * from './socket.constants';
export * from './wallet.constants';
export * from './room.constants';

/** Metadata keys used by decorators + guards. */
export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';
export const PERMISSIONS_KEY = 'permissions';
export const NOT_GUEST_KEY = 'notGuest';

/**
 * A fine-grained permission, by convention `resource:action` (e.g.
 * `wallet:adjust`, `user:read`). Kept an open string type here — the concrete
 * role→permission matrix is business logic defined in a later step.
 */
export type Permission = string;

/**
 * Platform roles (mirror of the Prisma `PlatformRole` enum / PRD hierarchy).
 * Kept as a plain const so guards and decorators can reference it without a
 * dependency on the generated Prisma client.
 */
export const PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'COUNTRY_MANAGER',
  'OFFICIAL',
  'MODERATOR',
  'BUSINESS_DEVELOPMENT',
  'AGENCY',
  'COIN_SELLER',
  'HOST',
  'USER',
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];
