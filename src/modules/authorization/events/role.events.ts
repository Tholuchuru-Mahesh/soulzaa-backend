import { DomainEvent } from 'src/common/events';

/**
 * Published when a user's role assignments change.
 *
 * The authorization module is @Global and its services are exported, but other
 * modules must not reach into them to *react* to a change — that would invert
 * the dependency. These events are the sanctioned outbound channel, and the
 * boundary rule explicitly permits importing another module's `events/`.
 */
export const ROLE_EVENTS = {
  ASSIGNED: 'role.assigned',
  REVOKED: 'role.revoked',
} as const;

export interface RoleChangePayload {
  userId: string;
  roleId: string;
  /** Null when the change was made by a system process rather than an operator. */
  actorId: string | null;
}

export class RoleAssignedEvent extends DomainEvent<RoleChangePayload> {
  readonly name = ROLE_EVENTS.ASSIGNED;
}

export class RoleRevokedEvent extends DomainEvent<RoleChangePayload> {
  readonly name = ROLE_EVENTS.REVOKED;
}
