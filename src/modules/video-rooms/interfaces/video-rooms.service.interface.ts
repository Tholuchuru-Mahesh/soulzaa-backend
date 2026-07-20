/**
 * Public contract for the video-rooms module — the ONLY surface other modules
 * may depend on (this token/interface or the EVENT_BUS). Internals (entities,
 * repositories, concrete services, media/state/session/presence managers) stay
 * private. The surface grows as later phases land; VR-0 exposes the one query
 * downstream domains (analytics, rankings, gifts) plausibly need.
 */
export const VIDEO_ROOMS_SERVICE = Symbol('VIDEO_ROOMS_SERVICE');

export interface IVideoRoomsService {
  /** True if the room exists, is not soft-deleted, and is currently LIVE. */
  isRoomLive(roomId: string): Promise<boolean>;
}
