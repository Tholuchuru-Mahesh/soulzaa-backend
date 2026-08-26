/**
 * Push categories and the Android notification channels they land on.
 *
 * A category is the unit the user opts out of, and the unit the OS groups by.
 * Both facts have to agree, so they are declared once, here, and consumed by the
 * preference gate (notification module) and the transport (this module) alike.
 */

export const PUSH_CATEGORIES = {
  /** A direct message or a chat request. */
  MESSAGE: 'MESSAGE',
  /** Incoming / missed / cancelled call. */
  CALL: 'CALL',
  FRIEND: 'FRIEND',
  FOLLOW: 'FOLLOW',
  /** Room / game / family / PK / event invitations. */
  INVITE: 'INVITE',
  GIFT: 'GIFT',
  /** Announcements and anything without a better home. */
  SYSTEM: 'SYSTEM',
  /** Coins in or out: recharge, refund, withdrawal decision, admin adjustment. */
  WALLET: 'WALLET',
  /** Match found, game settled. In-session churn is socket traffic, not push. */
  GAME: 'GAME',
  /** @deprecated — legacy VIP module notifications. Superseded by WEALTH. */
  VIP: 'VIP',
  /** Wealth Level up/downgrade, monthly reset, reward available/claimed. */
  WEALTH: 'WEALTH',
  /** Family membership changes. Family *invitations* ride INVITE. */
  FAMILY: 'FAMILY',
  /**
   * Account-security alerts (a suspicious login). Deliberately **not** gated by
   * notification preferences: the one device that must never be able to silence
   * a break-in alert is the one the attacker is holding.
   */
  SECURITY: 'SECURITY',
} as const;

export type PushCategory = (typeof PUSH_CATEGORIES)[keyof typeof PUSH_CATEGORIES];

/**
 * Android notification channel ids. **These strings are a contract with the
 * client**: an Android channel is created once, on first use, and its importance,
 * sound and vibration are immutable from then on — the app cannot change them
 * later, and neither can we. That is why sound/vibration are encoded in the
 * channel *id* rather than sent as flags: turning sound off has to mean landing
 * on a different, silent channel, and the only way that works is if the server
 * and the client agree on the id up front.
 *
 * Mirrored in the Flutter client (`push_channels.dart`), which registers every
 * one of these at boot.
 */
export const PUSH_CHANNELS = {
  /** Ringing call. Max importance, always audible — a silent ringtone is a bug. */
  CALLS: 'soulzaa_calls',
  /** Fallback, and the channel security alerts use. */
  DEFAULT: 'soulzaa_default',
} as const;

/** Channel id prefixes for the categories whose sound/vibration the user controls. */
const TUNABLE_CHANNEL_PREFIX = {
  [PUSH_CATEGORIES.MESSAGE]: 'soulzaa_messages',
  [PUSH_CATEGORIES.FRIEND]: 'soulzaa_social',
  [PUSH_CATEGORIES.FOLLOW]: 'soulzaa_social',
  [PUSH_CATEGORIES.INVITE]: 'soulzaa_social',
  [PUSH_CATEGORIES.GIFT]: 'soulzaa_social',
  [PUSH_CATEGORIES.WALLET]: 'soulzaa_wallet',
  [PUSH_CATEGORIES.GAME]: 'soulzaa_games',
  [PUSH_CATEGORIES.VIP]: 'soulzaa_vip',
  [PUSH_CATEGORIES.WEALTH]: 'soulzaa_wealth',
  [PUSH_CATEGORIES.FAMILY]: 'soulzaa_family',
} as const satisfies Partial<Record<PushCategory, string>>;

/** `s`/`n` = sound on/off, `v`/`n` = vibration on/off. */
function toneSuffix(sound: boolean, vibration: boolean): string {
  return `${sound ? 's' : 'n'}${vibration ? 'v' : 'n'}`;
}

/**
 * The channel a push lands on, given its category and the user's tone preferences.
 *
 * Calls ignore the tone preferences on purpose: a call you cannot hear is a call
 * you have missed. Security alerts ride the default channel for the same reason.
 */
export function pushChannelId(
  category: PushCategory,
  tone: { sound: boolean; vibration: boolean },
): string {
  if (category === PUSH_CATEGORIES.CALL) return PUSH_CHANNELS.CALLS;
  const prefix = TUNABLE_CHANNEL_PREFIX[category as keyof typeof TUNABLE_CHANNEL_PREFIX];
  if (!prefix) return PUSH_CHANNELS.DEFAULT;
  return `${prefix}_${toneSuffix(tone.sound, tone.vibration)}`;
}

/**
 * Every channel id the server can ever select. The client registers exactly this
 * set at boot; a push naming a channel the client never created is silently
 * dropped by Android, so the two lists must not drift.
 */
export const ALL_PUSH_CHANNEL_IDS: readonly string[] = [
  PUSH_CHANNELS.CALLS,
  PUSH_CHANNELS.DEFAULT,
  ...Object.values(TUNABLE_CHANNEL_PREFIX).flatMap((prefix) =>
    [true, false].flatMap((sound) =>
      [true, false].map((vibration) => `${prefix}_${toneSuffix(sound, vibration)}`),
    ),
  ),
].filter((id, i, all) => all.indexOf(id) === i);
