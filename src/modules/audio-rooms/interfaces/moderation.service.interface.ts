/**
 * Public contract for the AR-3 moderation layer — the cross-module read seam
 * (chat spam-actioning, gifts, admin portal) consume without importing
 * internals. Mutations happen through the moderation REST controller.
 */
export const MODERATION_SERVICE = Symbol('MODERATION_SERVICE');

export interface IModerationService {
  /** True when the user is on the room's kick list (kicked and not yet restored). */
  isKicked(roomId: string, userId: string): Promise<boolean>;

  /** True when the user has an active ban in the room. */
  isBanned(roomId: string, userId: string): Promise<boolean>;

  /** True when the user has an active moderator mute in the room. */
  isMuted(roomId: string, userId: string): Promise<boolean>;

  /** Throws ROOM_KICKED when the user is on the room's kick list. */
  assertNotKicked(roomId: string, userId: string): Promise<void>;

  /** Throws ROOM_BANNED when the user is actively banned. */
  assertNotBanned(roomId: string, userId: string): Promise<void>;
}
