/**
 * Public contract for the chat module — the ONLY surface other modules may
 * depend on (this token/interface or the EVENT_BUS). Internals (entities,
 * repositories, concrete services) stay private. Real methods replace the
 * marker below when the module is implemented.
 */
export const CHAT_SERVICE = Symbol('CHAT_SERVICE');

export interface IChatService {
  /** Placeholder marker for the not-yet-implemented public contract. */
  readonly __contract?: never;
}
