import { DomainEvent } from 'src/common/events';

/**
 * Wealth Level domain events on the EVENT_BUS. LEVEL_UP is consumed by the
 * audio-rooms socket bridge (badge/effect sync) and notifications;
 * DOWNGRADED/MONTHLY_RESET are emitted only by the monthly reset job;
 * REWARD_AVAILABLE/REWARD_CLAIMED drive the rewards notification + UI badge.
 */
export const WEALTH_EVENTS = {
  LEVEL_UP: 'wealth.level_up',
  DOWNGRADED: 'wealth.downgraded',
  MONTHLY_RESET: 'wealth.monthly_reset',
  REWARD_AVAILABLE: 'wealth.reward_available',
  REWARD_CLAIMED: 'wealth.reward_claimed',
} as const;

export class WealthLevelUpEvent extends DomainEvent<{
  userId: string;
  fromLevel: number;
  toLevel: number;
  currentExp: number;
  periodKey: string;
}> {
  readonly name = WEALTH_EVENTS.LEVEL_UP;
}

export class WealthDowngradedEvent extends DomainEvent<{
  userId: string;
  fromLevel: number;
  toLevel: number;
  periodKey: string;
}> {
  readonly name = WEALTH_EVENTS.DOWNGRADED;
}

export class WealthMonthlyResetEvent extends DomainEvent<{
  userId: string;
  previousPeriodKey: string;
  newPeriodKey: string;
  startingLevel: number;
}> {
  readonly name = WEALTH_EVENTS.MONTHLY_RESET;
}

export class WealthRewardAvailableEvent extends DomainEvent<{
  userId: string;
  rewardId: string;
  level: number;
}> {
  readonly name = WEALTH_EVENTS.REWARD_AVAILABLE;
}

export class WealthRewardClaimedEvent extends DomainEvent<{
  userId: string;
  rewardId: string;
  level: number;
}> {
  readonly name = WEALTH_EVENTS.REWARD_CLAIMED;
}
