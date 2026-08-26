import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DirectMessageType, NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { CHAT_SERVICE, type IChatService } from 'src/modules/chat/interfaces';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import { CacheService } from 'src/infra/redis/cache.service';
import { PROFILE_SERVICE, type IProfileService } from 'src/modules/users/interfaces';
import {
  COIN_SELLER_EVENTS,
  type CoinSellerSaleCompletedEvent,
} from '../events/coin-seller.events';

/** Shown when the seller's identity cannot be resolved — never a blank sender. */
const FALLBACK_SENDER = 'An agency';

/** A sale id is unique forever; an hour covers any redelivery storm. */
const ANNOUNCE_TTL_SECONDS = 3600;

/**
 * Tells the buyer an agency sent them coins — as a notification, and as a
 * durable line in the chat thread with that agency.
 *
 * Both halves live here rather than on the wallet's own notification listener
 * because `WalletMovementPayload` carries no `actorId`: that listener can say
 * "you received 500 coins" but not who from, and naming the agency is the
 * requirement. `COIN_SELLER_CREDIT` is deliberately absent from its
 * `NOTIFIABLE` map so the buyer is not told twice.
 *
 * The chat line is written as a `SYSTEM` message, which the app already renders
 * (`_SystemBody`) — no client change was needed for the record to appear. It is
 * a receipt, not a chat: the amount is in `content` so it survives in the
 * conversation list preview and in search, with the structured copy in
 * `metadata` for anything that wants to link back to the sale.
 */
@Injectable()
export class CoinSellerSaleListener implements OnModuleInit {
  private readonly logger = new Logger(CoinSellerSaleListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: INotificationService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
    @Inject(CHAT_SERVICE) private readonly chat: IChatService,
    // CacheService rather than NotificationGuard: the guard is internal to
    // NotificationModule, while RedisModule is @Global. Same once-only
    // semantics without widening another module's public surface.
    private readonly cache: CacheService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<CoinSellerSaleCompletedEvent>(COIN_SELLER_EVENTS.SALE_COMPLETED, (e) =>
      this.onSale(e),
    );
  }

  private async onSale(e: { payload: CoinSellerSaleCompletedEvent['payload'] }): Promise<void> {
    const { saleId, sellerId, buyerId, amount } = e.payload;

    // INCR is atomic, so exactly one delivery sees 1 — a redelivered event
    // cannot double-notify or post a second receipt. On a Redis failure we
    // announce anyway: a duplicate notification is a far smaller harm than
    // silently swallowing the only word the buyer gets that money arrived.
    let firstDelivery = true;
    try {
      const seen = await this.cache.increment(`coin-seller-sale:${saleId}`, {
        by: 1,
        ttlSeconds: ANNOUNCE_TTL_SECONDS,
      });
      firstDelivery = seen === 1;
    } catch (err) {
      this.logger.warn(`dedupe check failed for sale ${saleId}, announcing anyway: ${String(err)}`);
    }
    if (!firstDelivery) return;

    const senderName = await this.resolveSenderName(sellerId);

    await this.notify(buyerId, sellerId, saleId, amount, senderName);
    await this.writeChatReceipt(sellerId, buyerId, saleId, amount, senderName);
  }

  private async resolveSenderName(sellerId: string): Promise<string> {
    try {
      const identities = await this.profiles.resolvePublicIdentities([sellerId]);
      return identities.get(sellerId)?.displayName?.trim() || FALLBACK_SENDER;
    } catch (err) {
      this.logger.warn(`could not resolve seller ${sellerId}: ${String(err)}`);
      return FALLBACK_SENDER;
    }
  }

  private async notify(
    buyerId: string,
    sellerId: string,
    saleId: string,
    amount: number,
    senderName: string,
  ): Promise<void> {
    try {
      await this.notifications.create({
        userId: buyerId,
        type: NotificationType.COINS_RECEIVED,
        // The actor is the whole point — it is what lets the client show which
        // agency sent the coins rather than an anonymous credit.
        actorId: sellerId,
        entityType: 'CoinSellerUserSaleTransaction',
        entityId: saleId,
        data: { amount, senderName, sellerId },
      });

      await this.notifications.notify(buyerId, {
        category: PUSH_CATEGORIES.WALLET,
        title: 'Coins received',
        body: `${senderName} sent you ${amount} coins`,
        // How much money moved is nobody's business but the buyer's, least of
        // all a lock screen's — matching WalletNotificationListener.
        redactedBody: 'Your wallet was updated',
        data: { type: 'coin_seller_sale', saleId, sellerId },
        threadId: `wallet_${buyerId}`,
        badge: 'unread',
      });
    } catch (err) {
      this.logger.warn(`sale ${saleId} notification failed: ${String(err)}`);
    }
  }

  /**
   * Writes the receipt into the seller↔buyer thread, opening one if they have
   * never spoken. Opening is intended: a coin transfer is a real interaction,
   * and a receipt the buyer cannot find is not a receipt.
   */
  private async writeChatReceipt(
    sellerId: string,
    buyerId: string,
    saleId: string,
    amount: number,
    senderName: string,
  ): Promise<void> {
    try {
      const conversation = await this.chat.openDirect(sellerId, buyerId);

      await this.chat.sendMessage(sellerId, conversation.id, {
        // Derived from the sale id, not random: if this retries, chat's own
        // clientId idempotency collapses it instead of posting a second receipt.
        clientId: `coin-seller-sale-${saleId}`,
        type: DirectMessageType.SYSTEM,
        content: `${senderName} sent you ${amount} coins`,
        metadata: { kind: 'coin_seller_sale', saleId, sellerId, buyerId, amount },
      });
    } catch (err) {
      // A failed receipt must not lose the notification, and neither must lose
      // the sale — the coins have already moved.
      this.logger.warn(`sale ${saleId} chat receipt failed: ${String(err)}`);
    }
  }
}
