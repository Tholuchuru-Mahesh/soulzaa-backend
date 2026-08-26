import { DomainEvent } from 'src/common/events';

/**
 * Coin-seller domain events on the EVENT_BUS, so notifications and chat can
 * react to a sale without importing this module's internals.
 */
export const COIN_SELLER_EVENTS = {
  SALE_COMPLETED: 'coin-seller.sale.completed',
} as const;

export interface CoinSellerSaleCompletedPayload {
  /** `CoinSellerUserSaleTransaction.id` — the dedupe key for anything downstream. */
  saleId: string;
  /**
   * The seller. Also the agency id: `AgencyRelationship.agencyId` is a user id,
   * so the seller *is* the agency as far as the rest of the platform is concerned.
   */
  sellerId: string;
  buyerId: string;
  amount: number;
}

/**
 * A seller's coins reached a buyer's wallet and the sale row is committed.
 *
 * Deliberately separate from `WalletCreditedEvent`, which the buyer's credit
 * also raises. `WalletMovementPayload` carries no `actorId`, so a listener on
 * that event can say "you received 500 coins" but can never say *who from* —
 * and naming the sender is the entire point of this one. Anything that needs the
 * agency's identity must subscribe here.
 */
export class CoinSellerSaleCompletedEvent extends DomainEvent<CoinSellerSaleCompletedPayload> {
  readonly name = COIN_SELLER_EVENTS.SALE_COMPLETED;
}
