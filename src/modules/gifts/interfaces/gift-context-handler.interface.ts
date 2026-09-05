import type { Gift, GiftContextType, GiftTransaction, Prisma } from '@prisma/client';
import type { DomainEvent } from 'src/common/events';

/**
 * The gift-context seam (VR-10). Each gifting surface — audio room, video room,
 * and later live stream / private chat — owns a handler that supplies its own
 * validation and revenue split, while GiftService keeps the shared economy:
 * catalog, VIP gate, idempotency, rate limit, combo, lucky roll, wallet moves
 * and the immutable ledger.
 *
 * Handlers are registered by the module that owns the context (never by the
 * gifts module), so GiftService gains no room-type dependencies and no if-chain.
 */

/** A send being validated, before any money moves. */
export interface GiftContextRequest {
  contextType: GiftContextType;
  contextId: string;
  senderId: string;
  /** One entry for a single send; many for a multi-receiver batch. */
  receiverIds: string[];
  gift: Gift;
  quantity: number;
}

/** State handed to `onSend`, from inside the send transaction. */
export interface GiftSendContext extends GiftContextRequest {
  /**
   * Correlation id for this send, shared by every leg. Note this is NOT a
   * ledger row id — the rows do not exist yet when `onSend` runs.
   */
  transactionId: string;
  batchId: string;
  idempotencyKey: string;
  /** Total coins debited from the sender across all receivers. */
  totalCoinValue: number;
}

/**
 * Effects a handler contributes from inside the send transaction.
 *
 * A handler MUST NOT touch Redis, sockets, the queue or metrics in `onSend` —
 * the transaction boundary is Postgres-only. Non-Postgres work is returned as
 * `events` (published after commit) or `postCommit` (invoked after commit), so
 * a rolled-back send can never leak an un-rollbackable side effect.
 */
export interface GiftSendEffects {
  acceptedAmount: number;
  refundAmount: number;
  events: DomainEvent<unknown>[];
  postCommit?: () => Promise<void>;
  /**
   * When true, suppresses the receiver Available Balance (GOLD) cashback credit
   * entirely — used for video room gift-lock entry gifts where the receiver
   * earns only Soul Gems (DIAMOND) and no gold is returned to anyone.
   * Normal audio/video room gifts leave this false so the receiver gets both
   * Soul Gems (DIAMOND) and a Gold Coin cashback.
   */
  suppressReceiverCashback?: boolean;
  /**
   * When true, redirects the Gold Coin cashback to the sender instead of the
   * receiver. Currently always false — cashback always goes to the receiver in
   * all normal gifting contexts. Reserved for future use.
   */
  redirectCashbackToSender?: boolean;
}

export interface IGiftContextHandler {
  readonly contextType: GiftContextType;
  /** Max receivers one send may target. AUDIO_ROOM: 1. */
  readonly maxReceivers: number;

  /** Throws BusinessException when the send is not permitted. */
  validate(req: GiftContextRequest): Promise<void>;

  /**
   * Extra Redis lock keys this context needs held around the send transaction,
   * beyond the wallet locks GiftService always takes. AUDIO_ROOM returns the
   * treasure-room lock; VIDEO_ROOM returns nothing. Returned keys are merged
   * with the wallet keys and the whole set is sorted before acquisition, so
   * concurrent sends can never acquire two locks in opposing orders.
   */
  contextLockKeys?(req: GiftContextRequest): string[];

  /** In-transaction hook, after the debit and before the ledger write. */
  onSend?(tx: Prisma.TransactionClient, ctx: GiftSendContext): Promise<GiftSendEffects>;

  /** Post-commit hook — statistics, queue enqueue, room counters. */
  afterCommit?(txns: GiftTransaction[]): Promise<void>;
}
