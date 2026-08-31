import { DomainEvent } from 'src/common/events';

/**
 * Treasure box & rocket domain events on the EVENT_BUS (AR-6). The audio-rooms
 * module bridges these to the `/audio-room` namespace so participants see live
 * progress, opening animations and global announcements. Analytics/notifications
 * consume the same events without importing this module.
 */
export const TREASURE_EVENTS = {
  SESSION_STARTED: 'treasure.session_started',
  PROGRESS: 'treasure.progress',
  BOX_OPENED: 'treasure.box_opened',
  SESSION_COMPLETED: 'treasure.session_completed',
  RECEIVER_REWARD: 'treasure.receiver_reward',
  CONTRIBUTION_COUNTER_UPDATED: 'treasure.contribution_counter_updated',
  ROCKET_STARTED: 'treasure.rocket_started',
  ROCKET_PROGRESS: 'treasure.rocket_progress',
  ROCKET_COMPLETED: 'treasure.rocket_completed',
} as const;

/** A ranked contributor snapshot (Top-3 gifters / rocket contributors). */
export interface RankedContributor {
  rank: number;
  userId: string;
  amount: number;
}

/** A distributed-reward summary line (for the broadcast + announcement). */
export interface RewardSummary {
  userId: string;
  rank: number;
  kind: string;
  coins: number | null;
  itemName: string | null;
  /** Equippable cosmetic type (FRAME/THEME/ENTRANCE_EFFECT) for BACKPACK_ITEM. */
  itemType: string | null;
  /** Catalog cosmetic id the reward granted, if any. */
  itemRefId: string | null;
  /** Resolved, servable media/thumbnail URLs for the granted cosmetic. */
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  /** ISO timestamp when the granted cosmetic expires, or null for permanent. */
  expiresAt: string | null;
}

export class TreasureSessionStartedEvent extends DomainEvent<{
  roomId: string;
  sessionId: string;
  currentLevel: number;
  threshold: number;
}> {
  readonly name = TREASURE_EVENTS.SESSION_STARTED;
}

export class TreasureProgressEvent extends DomainEvent<{
  roomId: string;
  sessionId: string;
  level: number;
  progress: number;
  threshold: number;
  topGifters: RankedContributor[];
}> {
  readonly name = TREASURE_EVENTS.PROGRESS;
}

export class TreasureBoxOpenedEvent extends DomainEvent<{
  roomId: string;
  sessionId: string;
  level: number;
  topGifters: RankedContributor[];
  rewards: RewardSummary[];
  nextLevel: number | null;
}> {
  readonly name = TREASURE_EVENTS.BOX_OPENED;
}

export class TreasureSessionCompletedEvent extends DomainEvent<{
  roomId: string;
  sessionId: string;
}> {
  readonly name = TREASURE_EVENTS.SESSION_COMPLETED;
}

export class RocketStartedEvent extends DomainEvent<{
  roomId: string;
  rocketId: string;
  triggerGiftId: string;
  triggeredBy: string;
  endsAt: string;
}> {
  readonly name = TREASURE_EVENTS.ROCKET_STARTED;
}

export class RocketProgressEvent extends DomainEvent<{
  roomId: string;
  rocketId: string;
  totalContribution: number;
}> {
  readonly name = TREASURE_EVENTS.ROCKET_PROGRESS;
}

export class RocketCompletedEvent extends DomainEvent<{
  roomId: string;
  rocketId: string;
  totalContribution: number;
  rewards: RewardSummary[];
}> {
  readonly name = TREASURE_EVENTS.ROCKET_COMPLETED;
}

export class TreasureReceiverRewardEvent extends DomainEvent<{
  roomId: string;
  boxId: string;
  level: number;
  hostId: string;
  rewardAmount: number;
  walletTxnId: string | null;
}> {
  readonly name = TREASURE_EVENTS.RECEIVER_REWARD;
}

export class ContributionCounterUpdatedEvent extends DomainEvent<{
  roomId: string;
  /** Null on a week-rollover broadcast (no specific gift receiver). */
  receiverId: string | null;
  /** Lifetime totals — kept for admin/all-time; the app reads the *week* totals. */
  roomTotal: number;
  receiverTotal: number | null;
  /** Current ISO-week totals (the user-facing "Contrib" figure). */
  roomWeekTotal: number;
  receiverWeekTotal: number | null;
  /** ISO week key these week totals belong to (e.g. "2026W36"). */
  weekKey: string;
  /** Why the counter changed — a gift, or the Monday 00:00 UTC reset. */
  reason: 'gift' | 'week_rollover';
}> {
  readonly name = TREASURE_EVENTS.CONTRIBUTION_COUNTER_UPDATED;
}
