/**
 * Public contract for the payments module — the ONLY surface other modules may
 * depend on (this token/interface or the EVENT_BUS). Internals (entities,
 * repositories, concrete services) stay private. Real methods replace the
 * marker below when the module is implemented.
 */
export const PAYMENTS_SERVICE = Symbol('PAYMENTS_SERVICE');

export interface IPaymentsService {
  /** Placeholder marker for the not-yet-implemented public contract. */
  readonly __contract?: never;
}
