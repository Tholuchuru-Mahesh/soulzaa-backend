import type { VipLevel } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * VIP domain events on the EVENT_BUS. Upgrades are delivered to the user by the
 * audio-rooms socket bridge (entrance effects / badge sync) and consumed by
 * notifications/analytics.
 */
export const VIP_EVENTS = {
  UPGRADED: 'vip.upgraded',
} as const;

export class VipUpgradedEvent extends DomainEvent<{
  userId: string;
  fromLevel: VipLevel;
  toLevel: VipLevel;
  lifetimeRecharge: number;
  grantedCosmeticIds: string[];
}> {
  readonly name = VIP_EVENTS.UPGRADED;
}
