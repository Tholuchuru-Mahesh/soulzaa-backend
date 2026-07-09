/**
 * Public contract for the video-rooms module — the ONLY surface other modules may
 * depend on (this token/interface or the EVENT_BUS). Internals (entities,
 * repositories, concrete services) stay private. Real methods replace the
 * marker below when the module is implemented.
 */
export const VIDEO_ROOMS_SERVICE = Symbol('VIDEO_ROOMS_SERVICE');

export interface IVideoRoomsService {
  /** Placeholder marker for the not-yet-implemented public contract. */
  readonly __contract?: never;
}
