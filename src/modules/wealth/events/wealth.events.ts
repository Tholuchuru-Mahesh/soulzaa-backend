import { DomainEvent } from 'src/common/events';

/**
 * Wealth Level domain events on the EVENT_BUS. LEVEL_UP is consumed by the
 * audio-rooms socket bridge (badge/effect sync) and notifications;
 * DOWNGRADED/MONTHLY_RESET are emitted only by the monthly reset job;
 * BENEFIT_CLAIMED drives the rewards notification + UI badge.
 */
export const WEALTH_EVENTS = {
  LEVEL_UP: 'wealth.level_up',
  DOWNGRADED: 'wealth.downgraded',
  MONTHLY_RESET: 'wealth.monthly_reset',
  BENEFIT_CLAIMED: 'wealth.benefit_claimed',
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

export class WealthBenefitClaimedEvent extends DomainEvent<{
  userId: string;
  benefitId: string;
  level: number;
}> {
  readonly name = WEALTH_EVENTS.BENEFIT_CLAIMED;
}
