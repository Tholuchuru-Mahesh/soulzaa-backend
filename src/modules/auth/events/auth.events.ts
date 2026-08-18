import { DomainEvent } from 'src/common/events';

/**
 * Cross-module auth events. Other domains subscribe via the EVENT_BUS — e.g.
 * users/wallet/notification react to `user.registered` to create a profile,
 * open a wallet, and send a welcome. Auth only publishes; it never calls those
 * modules directly. Payloads are plain-serialisable for transport swap later.
 */

export const AUTH_EVENTS = {
  USER_REGISTERED: 'user.registered',
  USER_LOGGED_IN: 'user.logged_in',
  USER_LOGGED_OUT: 'user.logged_out',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_EMAIL_VERIFIED: 'user.email_verified',
  USER_MOBILE_VERIFIED: 'user.mobile_verified',
} as const;

export type AuthMethod = 'PASSWORD' | 'MOBILE_OTP' | 'GOOGLE' | 'APPLE' | 'FACEBOOK';

export class UserRegisteredEvent extends DomainEvent<{
  userId: string;
  method: AuthMethod;
  isGuest: boolean;
  email: string | null;
  mobile: string | null;
}> {
  readonly name = AUTH_EVENTS.USER_REGISTERED;
}

export class UserLoggedInEvent extends DomainEvent<{
  userId: string;
  sessionId: string;
  method: AuthMethod;
  deviceId: string | null;
  ip?: string;
}> {
  readonly name = AUTH_EVENTS.USER_LOGGED_IN;
}

export class UserLoggedOutEvent extends DomainEvent<{
  userId: string;
  sessionId: string | null;
  allDevices: boolean;
}> {
  readonly name = AUTH_EVENTS.USER_LOGGED_OUT;
}

export class UserPasswordChangedEvent extends DomainEvent<{
  userId: string;
  /** true when changed via the reset flow, false for an authenticated change. */
  viaReset: boolean;
}> {
  readonly name = AUTH_EVENTS.USER_PASSWORD_CHANGED;
}

export class UserEmailVerifiedEvent extends DomainEvent<{ userId: string; email: string }> {
  readonly name = AUTH_EVENTS.USER_EMAIL_VERIFIED;
}

export class UserMobileVerifiedEvent extends DomainEvent<{ userId: string; mobile: string }> {
  readonly name = AUTH_EVENTS.USER_MOBILE_VERIFIED;
}
