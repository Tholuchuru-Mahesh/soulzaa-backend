import type { BackpackItemType } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Backpack domain events on the EVENT_BUS. Notifications/analytics subscribe
 * without importing backpack internals.
 */
export const BACKPACK_EVENTS = {
  GRANTED: 'backpack.item_granted',
  EQUIPPED: 'backpack.item_equipped',
  UNEQUIPPED: 'backpack.item_unequipped',
  TRANSFERRED: 'backpack.item_transferred',
} as const;

export class BackpackItemGrantedEvent extends DomainEvent<{
  userId: string;
  itemId: string;
  type: BackpackItemType;
  name: string;
  source: string;
}> {
  readonly name = BACKPACK_EVENTS.GRANTED;
}

export class BackpackItemEquippedEvent extends DomainEvent<{
  userId: string;
  itemId: string;
  type: BackpackItemType;
}> {
  readonly name = BACKPACK_EVENTS.EQUIPPED;
}

export class BackpackItemUnequippedEvent extends DomainEvent<{
  userId: string;
  itemId: string;
  type: BackpackItemType;
}> {
  readonly name = BACKPACK_EVENTS.UNEQUIPPED;
}

export class BackpackItemTransferredEvent extends DomainEvent<{
  fromUserId: string;
  toUserId: string;
  itemId: string;
  newItemId: string;
}> {
  readonly name = BACKPACK_EVENTS.TRANSFERRED;
}
