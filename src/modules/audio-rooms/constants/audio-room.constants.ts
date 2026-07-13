/**
 * Audio Room module constants: the socket namespace, `room.*` event names,
 * Redis key builders, and small numeric limits. Config-driven values
 * (participant caps, cache TTLs) live in the `audioRoom` config namespace;
 * these are the fixed conventions shared across the repository/service/listener.
 */

/** Socket.IO namespace the AudioRoomGateway serves (see infra/socket). */
export const AUDIO_ROOM_NAMESPACE = '/audio-room';

/** Client-facing realtime event names broadcast into a room. */
export const ROOM_SOCKET_EVENTS = {
  CREATED: 'room.created',
  UPDATED: 'room.updated',
  DELETED: 'room.deleted',
  JOINED: 'room.joined',
  LEFT: 'room.left',
  CLOSED: 'room.closed',
  LOCKED: 'room.locked',
  OWNERSHIP_TRANSFERRED: 'room.ownership_transferred',
  // ---- Seats (AR-1) ----
  SEAT_REQUESTED: 'seat.requested',
  SEAT_ACCEPTED: 'seat.accepted',
  SEAT_REJECTED: 'seat.rejected',
  SEAT_LOCKED: 'seat.locked',
  SEAT_UNLOCKED: 'seat.unlocked',
  SEAT_JOINED: 'seat.joined',
  SEAT_LEFT: 'seat.left',
  SEAT_UPDATED: 'seat.updated',
  // ---- Voice (AR-2) ----
  VOICE_JOINED: 'voice.joined',
  VOICE_LEFT: 'voice.left',
  VOICE_MUTED: 'voice.muted',
  VOICE_UNMUTED: 'voice.unmuted',
  VOICE_SPEAKING: 'voice.speaking',
  VOICE_QUALITY: 'voice.quality',
  VOICE_RECONNECTED: 'voice.reconnected',
  VOICE_STATE: 'voice.state',
  VOICE_ROUTE: 'voice.route',
  VOICE_BACKGROUND: 'voice.background',
  // ---- Moderation (AR-3) ----
  MEMBER_KICKED: 'room.kicked',
  MEMBER_BANNED: 'room.banned',
  MEMBER_UNBANNED: 'room.unbanned',
  MEMBER_MUTED: 'member.muted',
  MEMBER_UNMUTED: 'member.unmuted',
  MEMBER_WARNED: 'member.warned',
  MEMBER_REPORTED: 'member.reported',
  APPEAL_SUBMITTED: 'moderation.appeal_submitted',
  APPEAL_RESOLVED: 'moderation.appeal_resolved',
  // ---- Chat (AR-4) ----
  CHAT_MESSAGE: 'chat.message',
  CHAT_TYPING: 'chat.typing',
  CHAT_PINNED: 'chat.pin',
  CHAT_UNPINNED: 'chat.unpin',
  CHAT_DELETED: 'chat.delete',
  CHAT_REACTION: 'chat.react',
  CHAT_ANNOUNCEMENT: 'chat.announcement',
  CHAT_REPORTED: 'chat.reported',
  CHAT_MENTION: 'chat.mention',
  // ---- Gifts (AR-5) ----
  GIFT_SENT: 'gift.sent',
  GIFT_COMBO: 'gift.combo',
  GIFT_LUCKY: 'gift.lucky',
  GIFT_RECEIVED: 'gift.received',
  // ---- Treasure boxes & rocket events (AR-6) ----
  TREASURE_STARTED: 'treasure.started',
  TREASURE_PROGRESS: 'treasure.progress',
  TREASURE_OPENED: 'treasure.opened',
  TREASURE_COMPLETED: 'treasure.completed',
  ROCKET_STARTED: 'rocket.started',
  ROCKET_PROGRESS: 'rocket.progress',
  ROCKET_COMPLETED: 'rocket.completed',
  // ---- EXP / Levels / VIP (AR-7) ----
  USER_LEVEL_UP: 'user.level_up',
  ROOM_LEVEL_UP: 'room.level_up',
  VIP_UPGRADED: 'vip.upgraded',
  // ---- Backpack cosmetics (AR-8) ----
  ROOM_APPEARANCE: 'room.appearance',
  ROOM_ENTRANCE_EFFECT: 'room.entrance_effect',
  // ---- Premium features (AR-9) ----
  PREMIUM_SEAT_GRANTED: 'premium.seat_granted',
  PREMIUM_SEAT_ENDED: 'premium.seat_ended',
  WATCH_PARTY: 'watch_party',
  // ---- PK Battles (AR-10) ----
  PK_STARTED: 'pk.started',
  PK_SCORE: 'pk.score',
  PK_ENDED: 'pk.ended',
  PK_CANCELLED: 'pk.cancelled',
  PK_INVITED: 'pk.invited',
  PK_REJECTED: 'pk.rejected',
  // ---- Lucky Packets (AR-14) ----
  LUCKY_PACKET_CREATED: 'lucky_packet.created',
  LUCKY_PACKET_CLAIMED: 'lucky_packet.claimed',
  LUCKY_PACKET_COMPLETED: 'lucky_packet.completed',
  LUCKY_PACKET_EXPIRED: 'lucky_packet.expired',
  // ---- Room Interactive Utilities (AR-15) ----
  POLL_CREATED: 'poll.created',
  POLL_VOTED: 'poll.voted',
  POLL_ENDED: 'poll.ended',
  DICE_ROLLED: 'dice.rolled',
  COIN_FLIPPED: 'coin.flipped',
  RANDOM_PICKED: 'random.picked',
  SPIN_RESULT: 'spin.result',
  COUNTDOWN_STARTED: 'countdown.started',
  COUNTDOWN_TICK: 'countdown.tick',
  COUNTDOWN_PAUSED: 'countdown.paused',
  COUNTDOWN_RESUMED: 'countdown.resumed',
  COUNTDOWN_COMPLETED: 'countdown.completed',
  COUNTDOWN_CANCELLED: 'countdown.cancelled',
} as const;

/** Validation bounds for room fields (mirrored by the DTOs). */
export const ROOM_NAME_MIN = 3;
export const ROOM_NAME_MAX = 60;
export const ROOM_DESCRIPTION_MAX = 500;
export const ROOM_PASSWORD_MIN = 4;
export const ROOM_PASSWORD_MAX = 64;
export const ROOM_MIN_PARTICIPANTS = 2;

/** bcrypt cost factor for room passwords (independent of account password rounds). */
export const ROOM_PASSWORD_SALT_ROUNDS = 10;

// ---- Redis keys (single-key ops → Cluster-safe; hash-tag the room id) ----

/** Cached room snapshot (JSON) — read-through on GET /rooms/:id. */
export function roomCacheKey(roomId: string): string {
  return `audio-room:{${roomId}}:snapshot`;
}

/** Sorted set scoring recent join activity for GET /rooms/trending. */
export const ROOM_TRENDING_KEY = 'audio-room:trending';

/**
 * Cached stage snapshot (seats + queue + settings) — read-through on GET stage,
 * invalidated on any seat/role/queue change. This is the module's hot-path
 * "Redis state" for the stage; the DB (room_seats + seat_queue) is authoritative.
 */
export function roomStageCacheKey(roomId: string): string {
  return `audio-room:{${roomId}}:stage`;
}

/** Per-room lock guarding seat claims / layout changes (serialises stage writes). */
export function roomSeatLockKey(roomId: string): string {
  return `audio-room:seat:{${roomId}}`;
}

/** The owner always occupies seat index 0. */
export const OWNER_SEAT_INDEX = 0;

/** A planned seat slot in the stage layout. */
export interface SeatSlot {
  seatIndex: number;
  seatType: 'OWNER' | 'PREMIUM_ADMIN' | 'SPEAKER';
}

/**
 * Build the ordered seat layout: seat 0 is the OWNER seat, then `premiumCount`
 * PREMIUM_ADMIN seats, then `speakerCount` SPEAKER seats. Deterministic indices
 * so a layout change maps old→new seats predictably.
 */
export function buildSeatLayout(premiumCount: number, speakerCount: number): SeatSlot[] {
  const slots: SeatSlot[] = [{ seatIndex: OWNER_SEAT_INDEX, seatType: 'OWNER' }];
  let index = 1;
  for (let i = 0; i < premiumCount; i++)
    slots.push({ seatIndex: index++, seatType: 'PREMIUM_ADMIN' });
  for (let i = 0; i < speakerCount; i++) slots.push({ seatIndex: index++, seatType: 'SPEAKER' });
  return slots;
}
