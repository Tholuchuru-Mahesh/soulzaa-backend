import type { CosmeticType } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/** Cosmetics domain events on the EVENT_BUS (premium store purchases). */
export const COSMETICS_EVENTS = {
  PURCHASED: 'cosmetic.purchased',
} as const;

export class CosmeticPurchasedEvent extends DomainEvent<{
  userId: string;
  cosmeticId: string;
  type: CosmeticType;
  name: string;
  price: number;
  backpackItemId: string;
}> {
  readonly name = COSMETICS_EVENTS.PURCHASED;
}
