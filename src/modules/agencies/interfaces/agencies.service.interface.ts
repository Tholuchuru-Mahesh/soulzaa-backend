/**
 * Public contract for the agencies module — the ONLY surface other modules may
 * depend on (this token/interface or the EVENT_BUS). Internals (entities,
 * repositories, concrete services) stay private. Real methods replace the
 * marker below when the module is implemented.
 */
export const AGENCIES_SERVICE = Symbol('AGENCIES_SERVICE');

export interface IAgenciesService {
  /** Placeholder marker for the not-yet-implemented public contract. */
  readonly __contract?: never;
}
