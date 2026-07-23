import { GiftCategory } from '@prisma/client';

/**
 * VR-10 gift engine constants: the `/video-room` socket vocabulary, the BullMQ
 * job name + priority policy, and every Redis key the engine owns.
 *
 * Redis keys follow the module convention `video-room:...`. Per-room keys embed
 * the room id so a room's state is discoverable and disposable as a unit.
 */

/** Outbound socket events on the `/video-room` namespace. */
export const VIDEO_ROOM_GIFT_SOCKET_EVENTS = {
  GIFT_SENT: 'video_room.gift_sent',
  GIFT_DELIVERED: 'video_room.gift_delivered',
  GIFT_ANIMATION: 'video_room.gift_animation',
  GIFT_COMBO_STARTED: 'video_room.gift_combo_started',
  GIFT_COMBO_UPDATED: 'video_room.gift_combo_updated',
  GIFT_COMBO_ENDED: 'video_room.gift_combo_ended',
  GIFT_QUEUE_UPDATED: 'video_room.gift_queue_updated',
  GIFT_FAILED: 'video_room.gift_failed',
  GIFT_RECOVERED: 'video_room.gift_recovered',
} as const;

/** BullMQ job name registered on QUEUE_NAMES.GIFT_PROCESSING. */
export const VIDEO_ROOM_GIFT_QUEUE_JOB = 'video-room.gift.deliver';

/**
 * BullMQ priority per gift category — lower runs sooner. Luxury and VIP gifts
 * are the ones users notice missing, so they jump the queue ahead of a burst of
 * cheap gifts.
 */
export const GIFT_CATEGORY_PRIORITY: Record<GiftCategory, number> = {
  [GiftCategory.VIP]: 1,
  [GiftCategory.LUXURY]: 1,
  [GiftCategory.PREMIUM]: 2,
  [GiftCategory.ANIMATED]: 2,
  [GiftCategory.LIMITED_EDITION]: 2,
  [GiftCategory.SPECIAL_EVENT]: 3,
  [GiftCategory.FESTIVAL]: 3,
  [GiftCategory.CLASSIC]: 4,
};

/** Delivery attempts per category before dead-lettering. */
export const GIFT_CATEGORY_ATTEMPTS: Record<GiftCategory, number> = {
  [GiftCategory.VIP]: 5,
  [GiftCategory.LUXURY]: 5,
  [GiftCategory.PREMIUM]: 5,
  [GiftCategory.ANIMATED]: 5,
  [GiftCategory.LIMITED_EDITION]: 5,
  [GiftCategory.SPECIAL_EVENT]: 5,
  [GiftCategory.FESTIVAL]: 5,
  [GiftCategory.CLASSIC]: 3,
};

/** Exponential backoff base for delivery retries. */
export const GIFT_DELIVERY_BACKOFF_MS = 500;

// ---- Redis keys ----

/** Capped list of recent gifts, powering `GET /gifts/recent`. */
export const giftRecentKey = (roomId: string): string => `video-room:${roomId}:gifts:recent`;

/** Combo counter for one (room, sender, gift); TTL is the gift's combo window. */
export const giftComboKey = (roomId: string, senderId: string, giftId: string): string =>
  `video-room:${roomId}:gift:combo:${senderId}:${giftId}`;

/**
 * Expiry index over every live combo, scored by expiry timestamp. A TTL'd key
 * expiring emits nothing, so `giftComboEnded` is driven by sweeping this ZSET
 * rather than by Redis keyspace notifications (which would need server config).
 */
export const GIFT_COMBO_INDEX_KEY = 'video-room:gift:combos';

/** Member encoding for the combo index — parsed back by the sweep. */
export const giftComboMember = (roomId: string, senderId: string, giftId: string): string =>
  `${roomId}|${senderId}|${giftId}`;

export interface ParsedComboMember {
  roomId: string;
  senderId: string;
  giftId: string;
}

/** Parse a combo index member; null when malformed (skipped by the sweep). */
export function parseGiftComboMember(member: string): ParsedComboMember | null {
  const parts = member.split('|');
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  return { roomId: parts[0], senderId: parts[1], giftId: parts[2] };
}

/** Hot per-room counters (gift count, coin total). */
export const giftStatsKey = (roomId: string): string => `video-room:${roomId}:gift:stats`;

/** Per-room top-gift ZSET — serves "top gifts" without unbounded metric labels. */
export const giftTopKey = (roomId: string): string => `video-room:${roomId}:gift:top`;

/** Per-room top-gifter ZSET (score = coins spent). */
export const giftTopSendersKey = (roomId: string): string =>
  `video-room:${roomId}:gift:top-senders`;

/** Serialises animation delivery within one room; rooms stay parallel. */
export const giftDeliverLockKey = (roomId: string): string => `video-room:gift:deliver:${roomId}`;

/** Guards the monitor tick so only one instance sweeps. */
export const GIFT_MONITOR_LOCK_KEY = 'video-room:gift:monitor';

/** Memoised active gift catalog (the hot read on the send path). */
export const GIFT_CATALOG_CACHE_KEY = 'gifts:catalog:active';

/** Hash fields used in the per-room hot stats key. */
export const GIFT_STATS_FIELD = {
  COUNT: 'count',
  COINS: 'coins',
} as const;

/** `video_room_events.eventType` values written by the gift engine. */
export const VIDEO_ROOM_GIFT_EVENT_TYPES = {
  ANIMATION_QUEUED: 'gift.animation.queued',
  DELIVERED: 'gift.delivered',
  DELIVERY_FAILED: 'gift.delivery.failed',
  RECOVERED: 'gift.recovered',
  REVERSED: 'gift.reversed',
} as const;
