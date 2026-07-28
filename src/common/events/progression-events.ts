/**
 * The domain signals that feed the progression engines — achievements, tasks &
 * missions, rankings and referrals.
 *
 * Each engine subscribes to this same list and forwards the bus event name
 * through as its `eventCode`, so what a given achievement or task responds to is
 * configured in the database (`unlockRule.eventCodes`, `TaskDefinition.eventCode`)
 * rather than compiled in. Supporting a new signal is one entry here; changing
 * what it *awards* needs no code at all.
 *
 * Names are literals rather than imports from the domain modules on purpose:
 * `common` sits underneath every module, so importing their event constants
 * upward would invert the dependency. These strings are the published contract.
 */
export const PROGRESSION_EVENT_NAMES: readonly string[] = [
  // Gifting
  'gift.sent',
  'gift.combo',
  'gift.lucky_win',
  // Progression
  'exp.user_leveled_up',
  'vip.upgraded',
  // Social / family
  'family.created',
  'family.member_joined',
  'social.friend.added',
  // Rooms
  'audio_room.created',
  'audio_room.joined',
  'video_room.created',
  'video_room.joined',
  // Games
  'game.settled',
  // Economy
  'wallet.credited',
  'coin_purchase.completed',
  // Treasure
  'treasure.box_opened',
  'treasure.rocket_completed',
  // Events
  'event.reward_claimed',
  // Identity
  'user.registered',
  'user.verified',
] as const;

/**
 * The user a progression signal belongs to.
 *
 * Payload shapes differ across domains, so this probes the conventional fields in
 * priority order. `senderId` sits above `actorId` because gifting credits the
 * sender. Returns null when a payload carries no subject (room-scoped events such
 * as `audio_room.ended`), which callers treat as "nothing to progress".
 */
export function resolveProgressionSubject(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  const direct = ['userId', 'senderId', 'actorId', 'ownerId', 'hostId'];
  for (const field of direct) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }

  const nested = record['user'];
  if (nested && typeof nested === 'object') {
    const id = (nested as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.length > 0) return id;
  }

  return null;
}
