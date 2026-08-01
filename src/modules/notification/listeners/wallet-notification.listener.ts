import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType, WalletTxnReason } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  WALLET_EVENTS,
  type WalletCreditedEvent,
  type WalletDebitedEvent,
  type WalletMovementPayload,
} from 'src/modules/wallet/events/wallet.events';
import {
  WITHDRAWAL_EVENTS,
  type WithdrawalApprovedEvent,
  type WithdrawalRejectedEvent,
} from 'src/modules/withdrawals/events/withdrawal.events';
import { GUARD_TTL } from '../constants/notification-guard.constants';
import { NotificationGuard } from '../services/notification-guard.service';
import { NotificationService } from '../services/notification.service';

/** Copy and type for one notifiable movement. */
interface WalletNotice {
  type: NotificationType;
  title: string;
  body: (amount: number) => string;
}

const refund = (): WalletNotice => ({
  type: NotificationType.REFUND_PROCESSED,
  title: 'Refund processed',
  body: (a) => `${a} coins refunded to your wallet`,
});

const earned = (title: string, verb: string): WalletNotice => ({
  type: NotificationType.COINS_RECEIVED,
  title,
  body: (a) => `You ${verb} ${a} coins`,
});

/**
 * The allowlist — deny by default.
 *
 * `WalletTxnReason` has 34 members and the wallet emits `CREDITED`/`DEBITED` on
 * every one of them, including `CASINO_BET`, `GAME_STAKE` and
 * `RESERVATION_HOLD`, which fire constantly during normal play. Enumerating what
 * a user actually wants to hear about is the only version of this that is not a
 * spam firehose.
 *
 * Two deliberate absences, both of which would otherwise double-notify:
 *  - `GIFT_RECEIVE` / `GIFT_SEND` — `GiftNotificationListener` already notifies
 *    the receiver on `GIFT_EVENTS.SENT`.
 *  - `GAME_PAYOUT` — `GameNotificationListener` already sends `GAME_WON`.
 */
const NOTIFIABLE: Partial<Record<WalletTxnReason, WalletNotice>> = {
  [WalletTxnReason.RECHARGE]: {
    type: NotificationType.RECHARGE_SUCCESS,
    title: 'Recharge successful',
    body: (a) => `${a} coins added to your wallet`,
  },

  [WalletTxnReason.GIFT_REFUND]: refund(),
  [WalletTxnReason.GAME_REFUND]: refund(),
  [WalletTxnReason.LUCKY_PACKET_REFUND]: refund(),
  [WalletTxnReason.CASINO_REFUND]: refund(),

  // An admin moving coins is the one balance change a user cannot explain from
  // their own actions, so it is the one worth telling them about.
  [WalletTxnReason.ADMIN_CREDIT]: earned('Coins received', 'received'),
  [WalletTxnReason.ADMIN_DEBIT]: {
    type: NotificationType.COINS_DEDUCTED,
    title: 'Coins deducted',
    body: (a) => `${a} coins were removed from your wallet`,
  },

  [WalletTxnReason.EVENT_REWARD]: earned('Reward received', 'earned'),
  [WalletTxnReason.ATTENDANCE_REWARD]: earned('Daily reward', 'earned'),
  [WalletTxnReason.SPIN_WHEEL_REWARD]: earned('Reward received', 'won'),
};

/**
 * Turns notable wallet movements into notifications.
 *
 * Because `reason` fully discriminates the cases, the wallet module needs no new
 * events — this listener reads the two it already publishes and decides for
 * itself which of them are worth a user's attention.
 */
@Injectable()
export class WalletNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    private readonly guard: NotificationGuard,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<WalletCreditedEvent>(WALLET_EVENTS.CREDITED, (e) => this.onMovement(e));
    this.bus.subscribe<WalletDebitedEvent>(WALLET_EVENTS.DEBITED, (e) => this.onMovement(e));

    // Withdrawals are money leaving the platform, and the decision arrives long
    // after the request — the user has no other way to learn the outcome.
    this.bus.subscribe<WithdrawalApprovedEvent>(WITHDRAWAL_EVENTS.APPROVED, (e) =>
      this.onWithdrawalDecision(e.payload, true),
    );
    this.bus.subscribe<WithdrawalRejectedEvent>(WITHDRAWAL_EVENTS.REJECTED, (e) =>
      this.onWithdrawalDecision(e.payload, false),
    );
  }

  private async onWithdrawalDecision(
    payload: { withdrawalId: string; userId: string; amount: number; reason?: string },
    approved: boolean,
  ): Promise<void> {
    const { withdrawalId, userId, amount, reason } = payload;

    await this.guard.once(`withdrawal:${withdrawalId}`, GUARD_TTL.WALLET_TXN, async () => {
      await this.notifications.create({
        userId,
        type: approved
          ? NotificationType.WITHDRAWAL_APPROVED
          : NotificationType.WITHDRAWAL_REJECTED,
        entityType: 'withdrawal_request',
        entityId: withdrawalId,
        data: { amount, ...(reason ? { reason } : {}) },
      });

      await this.notifications.notify(userId, {
        category: PUSH_CATEGORIES.WALLET,
        title: approved ? 'Withdrawal approved' : 'Withdrawal rejected',
        body: approved
          ? `Your withdrawal of ${amount} coins was approved`
          : `Your withdrawal of ${amount} coins was rejected${reason ? `: ${reason}` : ''}`,
        redactedBody: approved ? 'Your withdrawal was approved' : 'Your withdrawal was rejected',
        threadId: `wallet_${userId}`,
        badge: 'unread',
        data: { type: 'withdrawal', withdrawalId },
      });
    });
  }

  private async onMovement(e: { payload: WalletMovementPayload }): Promise<void> {
    const { userId, transactionId, amount, balanceAfter, reason } = e.payload;

    const notice = NOTIFIABLE[reason];
    if (!notice) return;

    await this.guard.once(`wallet:${transactionId}`, GUARD_TTL.WALLET_TXN, async () => {
      await this.notifications.create({
        userId,
        type: notice.type,
        entityType: 'wallet_transaction',
        entityId: transactionId,
        data: { amount, balanceAfter, reason },
      });

      await this.notifications.notify(userId, {
        category: PUSH_CATEGORIES.WALLET,
        title: notice.title,
        body: notice.body(amount),
        // How much money someone has, and how much just moved, is nobody's
        // business but theirs — least of all a lock screen's.
        redactedBody: 'Your wallet was updated',
        threadId: `wallet_${userId}`,
        badge: 'unread',
        data: { type: 'wallet', transactionId, reason },
      });
    });
  }
}
