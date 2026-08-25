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
  // Auth / Login
  'user.logged_in',
  'user.active',
  'auth.login',
  // Gifting
  'gift.sent',
  'gift.received',
  'gift.combo',
  'gift.lucky_win',
  // Progression
  'exp.user_leveled_up',
  'vip.upgraded',
  // Social / family
  'family.created',
  'family.member_joined',
  'social.followed',
  'social.unfollowed',
  'social.friend.accepted',
  'social.friend.added',
  // Rooms
  'audio_room.created',
  'audio_room.joined',
  'audio_room.left',
  'audio_room.voice_joined',
  'audio_room.seat_joined',
  'room.joined',
  'room.duration_updated',
  'video_room.created',
  'video_room.joined',
  // Games
  'game.settled',
  'game.started',
  'game.lobby_joined',
  'game.move',
  // Economy / Recharge
  'wallet.credited',
  'wallet.debited',
  'coin_purchase.completed',
  'recharge.success',
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
 * Resolves all user IDs a progression signal belongs to (e.g. all game participants,
 * winners, payout recipients, or individual actors).
 */
export function resolveProgressionSubjects(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const subjects = new Set<string>();

  // 1. Array of participants / members / winners / refunded users
  const arrayFields = ['participants', 'winners', 'members', 'refundedUserIds'];
  for (const field of arrayFields) {
    const list = record[field];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === 'string' && item.length > 0) subjects.add(item);
        else if (item && typeof item === 'object' && typeof (item as any).userId === 'string') {
          subjects.add((item as any).userId);
        }
      }
    }
  }

  // 2. Payouts array
  if (Array.isArray(record['payouts'])) {
    for (const p of record['payouts']) {
      if (
        p &&
        typeof p === 'object' &&
        typeof (p as any).userId === 'string' &&
        (p as any).userId.length > 0
      ) {
        subjects.add((p as any).userId);
      }
    }
  }

  // 3. Direct singular subject fields
  const direct = [
    'userId',
    'senderId',
    'receiverId',
    'actorId',
    'ownerId',
    'hostId',
    'requesterId',
    'addresseeId',
    'followerId',
    'followingId',
    'memberId',
    'playerId',
  ];
  for (const field of direct) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) subjects.add(value);
  }

  // 4. Nested user object
  const nested = record['user'];
  if (nested && typeof nested === 'object') {
    const id = (nested as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.length > 0) subjects.add(id);
  }

  return Array.from(subjects);
}

/**
 * The primary user a progression signal belongs to.
 */
export function resolveProgressionSubject(payload: unknown): string | null {
  const subjects = resolveProgressionSubjects(payload);
  return subjects.length > 0 ? subjects[0] : null;
}
