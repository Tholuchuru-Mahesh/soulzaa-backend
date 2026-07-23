/**
 * Safe coercion for use inside catch blocks whose whole purpose is to not
 * throw. A bare `(err as Error).message` blows up when `err` is
 * `undefined`/`null` (e.g. a rejected Redis command surfacing an empty
 * `Promise.reject()`, or a client library that rejects with a non-Error
 * value), which turns a swallow-and-log — or, worse, a FAIL-OPEN — catch into
 * a throw, defeating the whole point of the catch.
 *
 * This is the rankings-module twin of
 * `src/modules/video-rooms/constants/video-room-ranking.constants.ts`'s
 * `errorMessage`. It is duplicated rather than imported because the generic
 * `rankings` core must not depend on the `video-rooms` module — cross-module
 * imports are only permitted through a module's `interfaces/` or `events/`
 * (see `.dependency-cruiser.cjs`), and this helper is neither.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
