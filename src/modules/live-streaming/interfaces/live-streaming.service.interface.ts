/**
 * Public contract for the live-streaming module — the ONLY surface other modules may
 * depend on (this token/interface or the EVENT_BUS). Internals (entities,
 * repositories, concrete services) stay private. Real methods replace the
 * marker below when the module is implemented.
 */
export const LIVE_STREAMING_SERVICE = Symbol('LIVE_STREAMING_SERVICE');

export interface ILiveStreamingService {
  /** Placeholder marker for the not-yet-implemented public contract. */
  readonly __contract?: never;
}
