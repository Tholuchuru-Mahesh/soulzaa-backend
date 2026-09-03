import type { NotificationType } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import type { PushPriority } from 'src/modules/device/interfaces/push-provider.interface';
import type { PushCategory } from 'src/modules/device/interfaces/push.constants';

/**
 * Public contract for the notification module. Other modules never write to the
 * notification tables — they publish domain events, and this module's bridge
 * listeners create rows via NOTIFICATION_SERVICE.
 *
 * They also never push directly. `notify()` is the seam: it applies the
 * recipient's preferences and *then* hands a resolved message to the device
 * module. A producer calling DEVICE_SERVICE.pushToUser itself would be a producer
 * that silently ignored the user's settings, and nothing at the call site would
 * show that it had.
 */
export const NOTIFICATION_SERVICE = Symbol('NOTIFICATION_SERVICE');

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  data?: Record<string, unknown> | null;
}

export interface NotificationView {
  id: string;
  type: NotificationType;
  actorId: string | null;
  entityType: string | null;
  entityId: string | null;
  data: unknown;
  read: boolean;
  createdAt: Date;
}

/** The user's delivery settings. An absent row means every default, all on. */
export interface NotificationPreferenceView {
  pushEnabled: boolean;
  messageEvents: boolean;
  callEvents: boolean;
  friendEvents: boolean;
  followEvents: boolean;
  inviteEvents: boolean;
  giftEvents: boolean;
  systemEvents: boolean;
  // ---- VR-15 video-room categories ----
  roomEvents: boolean;
  seatEvents: boolean;
  treasureEvents: boolean;
  pkEvents: boolean;
  announcementEvents: boolean;
  // ---- Domain producer categories ----
  walletEvents: boolean;
  gameEvents: boolean;
  vipEvents: boolean;
  wealthEvents: boolean;
  familyEvents: boolean;
  sound: boolean;
  vibration: boolean;
  showPreview: boolean;
  /** "Mute all until". Null = not snoozed. */
  mutedUntil: Date | null;
}

/** Every field optional — a PUT that omits a key leaves it alone. */
export type UpdateNotificationPreferenceInput = Partial<NotificationPreferenceView>;

/**
 * What a producer *wants* to say to a user. Not yet a push: the category still has
 * to be checked against their preferences, the body may still be redacted, and the
 * Android channel is not chosen until we know whether they asked for sound.
 * `PushPolicy` turns this into a `PushMessage` — or into nothing.
 */
export interface PushIntent {
  category: PushCategory;
  title: string;
  /** The real text. May carry private content — see `redactedBody`. */
  body: string;
  /**
   * Sent *instead of* `body` when the user has previews turned off.
   *
   * Redaction happens on the server, not on the device: a lock-screen preview the
   * phone receives and then chooses not to draw has still been delivered to the
   * phone. Omit it when `body` carries nothing private ("Missed call" is not a
   * secret) and the body is used as-is.
   */
  redactedBody?: string;
  data?: Record<string, string>;
  priority?: PushPriority;
  ttlSeconds?: number;
  collapseKey?: string;
  /** Groups this push with its siblings on-device — one conversation, one thread. */
  threadId?: string;
  /** `'unread'` resolves to the user's current unread-notification count. */
  badge?: 'unread' | number;
  /** See `PushMessage.preferVoipOnIos` — threaded straight through by `PushPolicy`. */
  preferVoipOnIos?: boolean;
}

export interface INotificationService {
  create(input: CreateNotificationInput): Promise<NotificationView>;
  list(userId: string, page: number, limit: number): Promise<Paginated<NotificationView>>;
  markRead(userId: string, id: string): Promise<void>;
  markAllRead(userId: string): Promise<void>;
  unreadCount(userId: string): Promise<number>;

  // ---- Preferences ----
  preferences(userId: string): Promise<NotificationPreferenceView>;
  updatePreferences(
    userId: string,
    input: UpdateNotificationPreferenceInput,
  ): Promise<NotificationPreferenceView>;

  /**
   * Push to a user's devices, honouring their notification preferences.
   *
   * Returns false when the push was suppressed (master switch off, category off,
   * snoozed) — a normal outcome, not a failure. Enqueue-and-return: the caller
   * (a ringing call, say) must not wait on FCM, and must not fail because FCM did.
   */
  notify(userId: string, intent: PushIntent): Promise<boolean>;
}
