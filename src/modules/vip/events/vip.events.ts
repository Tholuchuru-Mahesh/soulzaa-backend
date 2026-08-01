import type { VipLevel } from 'src/common/enums/vip-level.enum';
import { DomainEvent } from 'src/common/events';

/**
 * VIP domain events on the EVENT_BUS. Upgrades are delivered to the user by the
 * audio-rooms socket bridge (entrance effects / badge sync) and consumed by
 * notifications/analytics.
 */
export const VIP_EVENTS = {
  UPGRADED: 'vip.upgraded',
  /**
   * Already published by `VipSubscriptionService` — these two were flowing on
   * the bus as bare string literals through the untyped
   * `VipEventService.publishVipEvent(name, payload)` before being declared here.
   */
  CREATED: 'vip.created',
  RENEWED: 'vip.renewed',
  /**
   * Emitted only by the expiry sweep. Nothing happens when time passes, so a
   * scheduled job is the only thing that can ever produce these.
   */
  EXPIRING: 'vip.expiring',
  EXPIRED: 'vip.expired',
} as const;

/**
 * `level` is the numeric tier (`VipMembership.level` / `VipTier.level`, both
 * `Int`) rather than the `VipLevel` enum — that is what the publishing sites
 * actually pass.
 */
export class VipCreatedEvent extends DomainEvent<{
  userId: string;
  level: number;
  expiresAt: Date;
}> {
  readonly name = VIP_EVENTS.CREATED;
}

export class VipRenewedEvent extends DomainEvent<{
  userId: string;
  level: number;
  expiresAt: Date;
}> {
  readonly name = VIP_EVENTS.RENEWED;
}

export class VipExpiringEvent extends DomainEvent<{
  userId: string;
  level: number;
  expiresAt: Date;
  daysRemaining: number;
}> {
  readonly name = VIP_EVENTS.EXPIRING;
}

export class VipExpiredEvent extends DomainEvent<{
  userId: string;
  level: number;
}> {
  readonly name = VIP_EVENTS.EXPIRED;
}

export class VipUpgradedEvent extends DomainEvent<{
  userId: string;
  fromLevel: VipLevel;
  toLevel: VipLevel;
  lifetimeRecharge: number;
  grantedCosmeticIds: string[];
}> {
  readonly name = VIP_EVENTS.UPGRADED;
}
