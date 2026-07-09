import type { AccountStatus, Gender, PlatformRole } from '@prisma/client';

/**
 * Public contract for the users module — the ONLY surface other modules
 * (notably auth) may depend on. Internals (entities, repositories, concrete
 * service) stay private. Auth uses this to create/read the identity record;
 * it never touches the `users` table via Prisma directly.
 */
export const USERS_SERVICE = Symbol('USERS_SERVICE');

/** A read model of the account identity row — no password/credential material. */
export interface UserIdentity {
  id: string;
  username: string;
  email: string | null;
  mobile: string | null;
  fullName: string | null;
  gender: Gender | null;
  dateOfBirth: Date | null;
  country: string | null;
  preferredLanguage: string | null;
  roles: PlatformRole[];
  isGuest: boolean;
  status: AccountStatus;
  emailVerifiedAt: Date | null;
  mobileVerifiedAt: Date | null;
  createdAt: Date;
}

/** Input to create a new account identity. Validated + age-checked by the service. */
export interface CreateIdentityInput {
  username: string;
  email?: string | null;
  mobile?: string | null;
  fullName?: string | null;
  gender?: Gender | null;
  dateOfBirth?: Date | null;
  country?: string | null;
  preferredLanguage?: string | null;
  roles?: PlatformRole[];
  isGuest?: boolean;
}

/** Fields a guest may set when promoting to a full account. */
export interface PromoteGuestInput {
  username?: string;
  email?: string | null;
  mobile?: string | null;
  fullName?: string | null;
  gender?: Gender | null;
  dateOfBirth?: Date | null;
  country?: string | null;
  preferredLanguage?: string | null;
}

export interface IUsersService {
  // ---- Queries ----
  findById(id: string): Promise<UserIdentity | null>;
  findByEmail(email: string): Promise<UserIdentity | null>;
  findByMobile(mobile: string): Promise<UserIdentity | null>;
  findByUsername(username: string): Promise<UserIdentity | null>;
  isEmailTaken(email: string): Promise<boolean>;
  isMobileTaken(mobile: string): Promise<boolean>;
  isUsernameTaken(username: string): Promise<boolean>;

  // ---- Commands ----
  createIdentity(input: CreateIdentityInput): Promise<UserIdentity>;
  markEmailVerified(id: string): Promise<void>;
  markMobileVerified(id: string): Promise<void>;
  promoteGuest(id: string, input: PromoteGuestInput): Promise<UserIdentity>;
  updateContact(id: string, contact: { email?: string; mobile?: string }): Promise<UserIdentity>;
}
