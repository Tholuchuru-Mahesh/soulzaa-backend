import { DomainEvent } from 'src/common/events';

/**
 * Privacy lifecycle events on the EVENT_BUS. The socket listener syncs clients
 * in realtime; analytics/moderation can subscribe. Dot-namespaced names
 * (fulfil the spec's privacy_updated / user_blocked / user_unblocked).
 */
export const PRIVACY_EVENTS = {
  UPDATED: 'privacy.updated',
  USER_BLOCKED: 'user.blocked',
  USER_UNBLOCKED: 'user.unblocked',
} as const;

export class PrivacyUpdatedEvent extends DomainEvent<{
  userId: string;
  kind: 'settings' | 'preferences';
  changed: string[];
}> {
  readonly name = PRIVACY_EVENTS.UPDATED;
}

export class UserBlockedEvent extends DomainEvent<{ blockerId: string; blockedId: string }> {
  readonly name = PRIVACY_EVENTS.USER_BLOCKED;
}

export class UserUnblockedEvent extends DomainEvent<{ blockerId: string; blockedId: string }> {
  readonly name = PRIVACY_EVENTS.USER_UNBLOCKED;
}
