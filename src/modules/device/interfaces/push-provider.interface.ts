import type { PushCategory } from './push.constants';

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

export type PushProviderName = 'console' | 'fcm' | 'apns' | 'apns-voip';

/**
 * Delivery urgency. `high` wakes a dozing device immediately (FCM high priority);
 * `normal` may be batched by the OS to save battery.
 *
 * A ringing call is the canonical `high`: it is worthless if it arrives after the
 * caller has given up. Almost everything else is `normal` — marking routine
 * notifications high is how an app gets its push privileges throttled.
 */
export type PushPriority = 'high' | 'normal';

/**
 * A fully-resolved push notification, ready for a single device token.
 *
 * "Resolved" is the load-bearing word: by the time a message reaches a provider,
 * the recipient's notification preferences have already been applied to it (see
 * the notification module's `PushPolicy`) — the body is already redacted if
 * previews are off, and `channelId` already names the silent channel if sound is
 * off. A provider makes no policy decisions; it only puts bytes on a wire.
 */
export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
  /** What this push is about — gates preferences upstream, groups it on-device. */
  category: PushCategory;
  /** Defaults to `normal`. */
  priority?: PushPriority;
  /**
   * Drop the message if it could not be delivered within this many seconds.
   *
   * Matters most for calls: an incoming-call push that surfaces after the ring
   * window has closed rings a phone for a call that no longer exists. Expiring it
   * in transit is strictly better than delivering it late.
   */
  ttlSeconds?: number;
  /**
   * Supersede any still-undelivered message sharing this key. Used so a
   * `call_missed` push replaces the `call_incoming` one queued for a device that
   * was offline, rather than the device receiving both, in order, seconds apart.
   */
  collapseKey?: string;
  /**
   * Android channel id (see `push.constants`). The channel carries the sound and
   * vibration the user asked for, because on Android that is the only place those
   * can live.
   */
  channelId: string;
  /**
   * Groups related notifications on the device — the APNs `thread-id`, and the
   * group key the Android client stacks under. One conversation, one thread: ten
   * messages from the same chat collapse into one expandable stack rather than
   * ten separate banners.
   */
  threadId?: string;
  /** App-icon badge to set. Omitted leaves whatever badge the device already shows. */
  badge?: number;
  /** iOS alert sound. Android's sound belongs to `channelId` and cannot be set here. */
  sound?: boolean;
  /**
   * Route an iOS device with a registered VoIP token through the PushKit/APNs-voip
   * transport instead of the normal alert path — the only delivery Apple honours
   * to a force-quit app, and the one that carries the CallKit-reporting
   * obligation. Set only on the handful of call-lifecycle pushes a backgrounded
   * device must act on immediately (incoming/missed/cancelled); every other push
   * category leaves this unset and keeps using the normal alert push, even on
   * iOS devices that also happen to have a VoIP token registered.
   */
  preferVoipOnIos?: boolean;
}

/**
 * Sends a push notification to a device token. Implementations wrap FCM/APNS
 * (or log — console). The dispatcher/processor depend only on this interface,
 * so a provider is swapped via the PUSH_PROVIDER binding without touching the
 * device flow.
 */
export interface IPushProvider {
  readonly name: PushProviderName;
  /**
   * Deliver to one token.
   *
   * Throws {@link PushTokenInvalidError} when the *token* is the problem (the app
   * was uninstalled, the token rotated) rather than the request. That distinction
   * is what lets the dispatcher retire a dead token instead of retrying it on
   * every push for the rest of time.
   */
  send(token: string, message: PushMessage): Promise<void>;
}

/**
 * The token is permanently unusable: the app was uninstalled, the token was
 * replaced, or it never belonged to this project. Retrying cannot help, so the
 * dispatcher clears it from the registry rather than burning a send on it forever.
 */
export class PushTokenInvalidError extends Error {
  constructor(
    readonly token: string,
    readonly reason: string,
  ) {
    super(`push token invalid (${reason})`);
    this.name = 'PushTokenInvalidError';
  }
}
