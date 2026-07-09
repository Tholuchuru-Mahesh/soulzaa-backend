import { DomainEvent } from 'src/common/events';

/**
 * Session lifecycle events on the EVENT_BUS. Consumed by the socket listener
 * (disconnect live sockets on logout), and available to analytics/security.
 * Payloads are plain-serialisable; never carry token material.
 */
export const SESSION_EVENTS = {
  CREATED: 'session.created',
  REFRESHED: 'session.refreshed',
  EXPIRED: 'session.expired',
  REVOKED: 'session.revoked',
  LOGGED_OUT: 'session.logged_out',
} as const;

export class SessionCreatedEvent extends DomainEvent<{
  userId: string;
  sessionId: string;
  deviceId: string | null;
  ip?: string;
}> {
  readonly name = SESSION_EVENTS.CREATED;
}

export class SessionRefreshedEvent extends DomainEvent<{
  userId: string;
  sessionId: string;
  replacedSessionId: string;
}> {
  readonly name = SESSION_EVENTS.REFRESHED;
}

export class SessionExpiredEvent extends DomainEvent<{ userId: string; sessionId: string }> {
  readonly name = SESSION_EVENTS.EXPIRED;
}

export class SessionRevokedEvent extends DomainEvent<{
  userId: string;
  sessionId: string;
  reason: 'user' | 'reuse' | 'hijack' | 'concurrent' | 'admin';
}> {
  readonly name = SESSION_EVENTS.REVOKED;
}

export class SessionLoggedOutEvent extends DomainEvent<{
  userId: string;
  sessionId: string | null;
  allDevices: boolean;
  byAdmin?: boolean;
}> {
  readonly name = SESSION_EVENTS.LOGGED_OUT;
}
