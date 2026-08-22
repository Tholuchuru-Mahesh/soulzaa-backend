import type { PrivacyLevel } from '@prisma/client';

/**
 * Public contract for the privacy module — the ONLY surface other modules
 * (profile, chat, calls, presence) may depend on. Internals (repository, check
 * engine, socket listener) stay private. Consumers resolve PRIVACY_SERVICE to
 * gate visibility/permissions and read the block list.
 */
export const PRIVACY_SERVICE = Symbol('PRIVACY_SERVICE');

/** An action a viewer may attempt against a target, gated by a PrivacyLevel. */
export enum PrivacyAction {
  VIEW_PROFILE = 'VIEW_PROFILE',
  VIEW_ONLINE = 'VIEW_ONLINE',
  VIEW_LAST_SEEN = 'VIEW_LAST_SEEN',
  MESSAGE = 'MESSAGE',
  CALL = 'CALL',
  FRIEND_REQUEST = 'FRIEND_REQUEST',
}

export interface PrivacySettingsView {
  onlineStatus: PrivacyLevel;
  lastSeen: PrivacyLevel;
  profileVisibility: PrivacyLevel;
  callPermission: PrivacyLevel;
  messagePermission: PrivacyLevel;
  friendRequestPermission: PrivacyLevel;
}

export interface PreferencesView {
  searchable: boolean;
  showActivity: boolean;
  readReceipts: boolean;
  allowTagging: boolean;
}

export interface BlockedUserView {
  userId: string;
  reason: string | null;
  createdAt: Date;
  username?: string;
  fullName?: string | null;
  avatarKey?: string | null;
}

export interface IPrivacyService {
  // ---- Settings + preferences ----
  getSettings(userId: string): Promise<PrivacySettingsView>;
  updateSettings(userId: string, patch: Partial<PrivacySettingsView>): Promise<PrivacySettingsView>;
  getPreferences(userId: string): Promise<PreferencesView>;
  updatePreferences(userId: string, patch: Partial<PreferencesView>): Promise<PreferencesView>;

  // ---- Blocking ----
  block(blockerId: string, blockedId: string, reason?: string): Promise<void>;
  unblock(blockerId: string, blockedId: string): Promise<void>;
  listBlocked(blockerId: string): Promise<BlockedUserView[]>;
  isBlocked(blockerId: string, blockedId: string): Promise<boolean>;
  isBlockedEitherWay(a: string, b: string): Promise<boolean>;
  /** All user ids in a block relationship with `userId` (both directions). */
  blockedIdsFor(userId: string): Promise<string[]>;

  // ---- Checks ----
  /** Whether `viewerId` (null = anonymous) may perform `action` against `targetId`. */
  check(viewerId: string | null, targetId: string, action: PrivacyAction): Promise<boolean>;
}
