import { DomainEvent } from 'src/common/events';

/**
 * VR-10 gift events owned by the video-rooms module.
 *
 * Deliberately NOT re-declared here: `gift.sent`, `gift.combo`, `gift.lucky_win`
 * and `gift.refunded` are published by the gifts module and consumed by
 * notifications, EXP, rankings, social and analytics. Re-publishing them would
 * double-fire every one of those listeners. The socket bridge relays those
 * events by filtering on `contextType === VIDEO_ROOM`; only delivery and combo
 * *lifecycle* — concepts with no audio-room counterpart — are declared here.
 */
export const VIDEO_ROOM_GIFT_EVENTS = {
  ANIMATION: 'video_room.gift.animation',
  DELIVERED: 'video_room.gift.delivered',
  FAILED: 'video_room.gift.failed',
  RECOVERED: 'video_room.gift.recovered',
  QUEUE_UPDATED: 'video_room.gift.queue_updated',
  COMBO_STARTED: 'video_room.gift.combo_started',
  COMBO_UPDATED: 'video_room.gift.combo_updated',
  COMBO_ENDED: 'video_room.gift.combo_ended',
} as const;

/**
 * Correlation envelope carried by every per-leg delivery event, in both the
 * socket payload and the `video_room_events` row.
 *
 * Three identifier levels, each already owned by something:
 *  - `batchId`    — the send; one per API call; the delivery lifecycle key
 *  - `jobId`      — one attempt-run; BullMQ mints a NEW id on every DLQ replay,
 *                   which is why no separate deliveryId is needed
 *  - `attempt`    — the retry within a run
 *  - `transactionId` ↔ `receiverId` — this receiver's leg
 */
export interface GiftDeliveryCorrelation {
  batchId: string;
  transactionId: string;
  roomId: string;
  senderId: string;
  receiverId: string;
  giftId: string;
  jobId: string;
  attempt: number;
}

/**
 * Batch-level correlation. Animation is the one event emitted per SEND rather
 * than per leg — a "gift the whole stage" plays one animation, not N — so it
 * carries the arrays in place of the singular pair.
 */
export interface GiftAnimationCorrelation {
  batchId: string;
  transactionIds: string[];
  roomId: string;
  senderId: string;
  receiverIds: string[];
  giftId: string;
  jobId: string;
  attempt: number;
}

/** Presentation payload accompanying an animation trigger. */
export interface GiftAnimationPayload extends GiftAnimationCorrelation {
  giftName: string;
  animationUrl: string | null;
  soundUrl: string | null;
  comboTier: number;
  quantity: number;
  totalCoinValue: number;
}

export class VideoRoomGiftAnimationEvent extends DomainEvent<GiftAnimationPayload> {
  readonly name = VIDEO_ROOM_GIFT_EVENTS.ANIMATION;
}

export class VideoRoomGiftDeliveredEvent extends DomainEvent<GiftDeliveryCorrelation> {
  readonly name = VIDEO_ROOM_GIFT_EVENTS.DELIVERED;
}

export class VideoRoomGiftFailedEvent extends DomainEvent<
  GiftDeliveryCorrelation & { reason: string }
> {
  readonly name = VIDEO_ROOM_GIFT_EVENTS.FAILED;
}

export class VideoRoomGiftRecoveredEvent extends DomainEvent<{
  batchId: string;
  roomId: string;
  /** The DLQ job replayed; the replay itself gets a fresh BullMQ job id. */
  jobId: string;
}> {
  readonly name = VIDEO_ROOM_GIFT_EVENTS.RECOVERED;
}

/**
 * Live delivery-queue depth, so clients can show a backlog indicator during a
 * gift storm rather than appearing frozen while animations catch up.
 */
export class VideoRoomGiftQueueUpdatedEvent extends DomainEvent<{
  roomId: string;
  batchId: string;
  category: string;
  /** Jobs waiting or delayed. */
  pending: number;
  /** Jobs currently being delivered. */
  active: number;
}> {
  readonly name = VIDEO_ROOM_GIFT_EVENTS.QUEUE_UPDATED;
}

/** Shared shape of the three combo lifecycle events. */
export interface GiftComboPayload {
  roomId: string;
  senderId: string;
  giftId: string;
  /**
   * Streak length. Display only — combo never multiplies cost (only
   * `luckyMultiplier` affects totalCoinValue), matching Audio Rooms.
   */
  comboTier: number;
  /** Coins accumulated across the streak, for the client's combo meter. */
  totalCoinValue: number;
  expiresAt: string;
}

export class VideoRoomGiftComboStartedEvent extends DomainEvent<GiftComboPayload> {
  readonly name = VIDEO_ROOM_GIFT_EVENTS.COMBO_STARTED;
}

export class VideoRoomGiftComboUpdatedEvent extends DomainEvent<GiftComboPayload> {
  readonly name = VIDEO_ROOM_GIFT_EVENTS.COMBO_UPDATED;
}

export class VideoRoomGiftComboEndedEvent extends DomainEvent<{
  roomId: string;
  senderId: string;
  giftId: string;
  finalTier: number;
}> {
  readonly name = VIDEO_ROOM_GIFT_EVENTS.COMBO_ENDED;
}
