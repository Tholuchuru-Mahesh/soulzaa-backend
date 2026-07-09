/**
 * Public contract for the notification module — the ONLY surface other modules may
 * depend on (this token/interface or the EVENT_BUS). Internals (entities,
 * repositories, concrete services) stay private. Real methods replace the
 * marker below when the module is implemented.
 */
export const NOTIFICATION_SERVICE = Symbol('NOTIFICATION_SERVICE');

export interface INotificationService {
  /** Placeholder marker for the not-yet-implemented public contract. */
  readonly __contract?: never;
}
