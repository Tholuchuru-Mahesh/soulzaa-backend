import { Injectable } from '@nestjs/common';
import type { PushMessage } from 'src/modules/device/interfaces/push-provider.interface';
import {
  PUSH_CATEGORIES,
  pushChannelId,
  type PushCategory,
} from 'src/modules/device/interfaces/push.constants';
import type { NotificationPreferenceView, PushIntent } from '../interfaces/notification.interface';

/**
 * Which preference switch gates which category. Exhaustive over `PushCategory` by
 * construction, so adding a category without deciding how a user turns it off
 * fails to compile — which is the point. A category with no switch is a category
 * nobody can escape.
 */
const CATEGORY_SWITCH: Record<PushCategory, keyof NotificationPreferenceView | null> = {
  [PUSH_CATEGORIES.MESSAGE]: 'messageEvents',
  [PUSH_CATEGORIES.CALL]: 'callEvents',
  [PUSH_CATEGORIES.FRIEND]: 'friendEvents',
  [PUSH_CATEGORIES.FOLLOW]: 'followEvents',
  [PUSH_CATEGORIES.INVITE]: 'inviteEvents',
  [PUSH_CATEGORIES.GIFT]: 'giftEvents',
  [PUSH_CATEGORIES.SYSTEM]: 'systemEvents',
  [PUSH_CATEGORIES.WALLET]: 'walletEvents',
  [PUSH_CATEGORIES.GAME]: 'gameEvents',
  [PUSH_CATEGORIES.VIP]: 'vipEvents',
  [PUSH_CATEGORIES.FAMILY]: 'familyEvents',
  // Not gated, on purpose. See PUSH_CATEGORIES.SECURITY.
  [PUSH_CATEGORIES.SECURITY]: null,
};

/**
 * Turns a producer's {@link PushIntent} into the {@link PushMessage} that will
 * actually be sent — or into nothing, if the user asked not to be told.
 *
 * This is the *only* place notification preferences are applied, and it sits on
 * the send path rather than the read path so that a preference cannot be honoured
 * "mostly". Three things happen here and nowhere else:
 *
 *  1. **Suppression** — master switch, snooze window, per-category switch.
 *  2. **Redaction** — a body carrying private content is swapped for a generic one
 *     *before it leaves the server*, which is the only redaction that is actually
 *     private.
 *  3. **Channel selection** — sound and vibration live in the Android channel id,
 *     because on Android that is the only place they can live (a channel's tone is
 *     frozen the moment it is created).
 */
@Injectable()
export class PushPolicy {
  /**
   * @param unreadCount resolves the app-icon badge. Injected as a function rather
   * than a service to keep this class free of the notification store — it decides
   * what to send, not what has happened.
   */
  resolve(
    intent: PushIntent,
    prefs: NotificationPreferenceView,
    unreadCount: number,
  ): PushMessage | null {
    if (!this.allows(intent.category, prefs)) return null;

    const body = prefs.showPreview ? intent.body : (intent.redactedBody ?? intent.body);
    const badge = intent.badge === 'unread' ? unreadCount : intent.badge;

    return {
      category: intent.category,
      title: intent.title,
      body,
      data: intent.data,
      priority: intent.priority,
      ttlSeconds: intent.ttlSeconds,
      collapseKey: intent.collapseKey,
      threadId: intent.threadId,
      channelId: pushChannelId(intent.category, {
        sound: prefs.sound,
        vibration: prefs.vibration,
      }),
      badge,
      sound: prefs.sound,
    };
  }

  /** Whether this category may be delivered at all right now. */
  allows(category: PushCategory, prefs: NotificationPreferenceView): boolean {
    const gate = CATEGORY_SWITCH[category];
    if (gate === null) return true; // SECURITY — never suppressed.

    if (!prefs.pushEnabled) return false;
    if (prefs.mutedUntil && prefs.mutedUntil.getTime() > Date.now()) return false;
    return prefs[gate] === true;
  }

  /** True when `intent.badge === 'unread'`, i.e. the caller needs a count resolved. */
  needsUnreadCount(intent: PushIntent): boolean {
    return intent.badge === 'unread';
  }
}
