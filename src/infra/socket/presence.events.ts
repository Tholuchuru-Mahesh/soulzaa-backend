import { DomainEvent } from 'src/common/events';

/**
 * Infra-level presence event published when a user's COARSE online state flips
 * (their first socket connects / last socket disconnects). Domains subscribe to
 * enrich it (e.g. the social module fans out `presence:updated` to friends and
 * persists lastSeen). Kept separate from the client-facing `presence:online/
 * offline` socket emits, which stay unchanged for backward compatibility.
 */
export const INFRA_PRESENCE_EVENTS = {
  CHANGED: 'presence.changed',
} as const;

export class PresenceChangedEvent extends DomainEvent<{ userId: string; online: boolean }> {
  readonly name = INFRA_PRESENCE_EVENTS.CHANGED;
}
