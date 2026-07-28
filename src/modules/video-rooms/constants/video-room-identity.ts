/**
 * Identity cache keys/TTL for the video-room display surfaces.
 *
 * Short TTL by design: identity is display-only, so a stale name for up to a
 * minute is harmless, while the `user.profile_updated` / `user.avatar_updated`
 * invalidation (see `VideoRoomIdentityCacheListener`) makes the common
 * edit-your-profile case update immediately anyway.
 *
 * The `{userId}` hash tag matches the convention used by the seat queue keys
 * (`video-room:seatq:{roomId}`) so a future Redis Cluster keeps a user's key on
 * one slot.
 */
export const VIDEO_ROOM_IDENTITY_TTL_SECONDS = 60;

export function videoRoomIdentityKey(userId: string): string {
  return `video-room:identity:{${userId}}`;
}
