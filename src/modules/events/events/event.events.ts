import type { EventType } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Events domain events on the EVENT_BUS. Reward claims are delivered to the user
 * (notification) and consumed by analytics without importing this module.
 */
export const EVENT_EVENTS = {
  REWARD_CLAIMED: 'event.reward_claimed',
} as const;

export interface EventRewardSummary {
  kind: string;
  coins: number | null;
  currency: string | null;
  cosmeticId: string | null;
  exp: number | null;
}

export class EventRewardClaimedEvent extends DomainEvent<{
  eventId: string;
  eventType: EventType;
  userId: string;
  rewards: EventRewardSummary[];
}> {
  readonly name = EVENT_EVENTS.REWARD_CLAIMED;
}
