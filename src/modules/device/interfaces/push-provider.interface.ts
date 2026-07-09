export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

export type PushProviderName = 'console' | 'fcm' | 'apns';

/** A push notification payload delivered to a single device token. */
export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Sends a push notification to a device token. Implementations wrap FCM/APNS
 * (or log — console). The dispatcher/processor depend only on this interface,
 * so a provider is swapped via the PUSH_PROVIDER binding without touching the
 * device flow.
 */
export interface IPushProvider {
  readonly name: PushProviderName;
  send(token: string, message: PushMessage): Promise<void>;
}
