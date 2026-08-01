import { NotificationType, WalletTxnReason } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import { WALLET_EVENTS } from 'src/modules/wallet/events/wallet.events';
import { WITHDRAWAL_EVENTS } from 'src/modules/withdrawals/events/withdrawal.events';
import type { NotificationGuard } from '../services/notification-guard.service';
import type { NotificationService } from '../services/notification.service';
import { WalletNotificationListener } from './wallet-notification.listener';

const USER = 'user-1';

type Handler = (e: { payload: Record<string, unknown> }) => Promise<void>;

const payload = (overrides: Record<string, unknown> = {}) => ({
  userId: USER,
  transactionId: 'txn-1',
  currency: 'COIN',
  amount: 500,
  balanceAfter: 1500,
  reason: WalletTxnReason.RECHARGE,
  referenceType: null,
  referenceId: null,
  ...overrides,
});

describe('WalletNotificationListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let guard: { once: jest.Mock };
  let credited: (e: { payload: ReturnType<typeof payload> }) => Promise<void>;
  let debited: (e: { payload: ReturnType<typeof payload> }) => Promise<void>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    // Pass-through guard — dedupe behaviour has its own spec.
    guard = {
      once: jest.fn((_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
    };

    const listener = new WalletNotificationListener(
      bus as unknown as IEventBus,
      notifications as unknown as NotificationService,
      guard as unknown as NotificationGuard,
    );
    listener.onModuleInit();

    const byEvent = new Map<string, (e: { payload: ReturnType<typeof payload> }) => Promise<void>>(
      bus.subscribe.mock.calls as [
        string,
        (e: { payload: ReturnType<typeof payload> }) => Promise<void>,
      ][],
    );
    credited = byEvent.get(WALLET_EVENTS.CREDITED)!;
    debited = byEvent.get(WALLET_EVENTS.DEBITED)!;
  });

  it('notifies on a successful recharge', async () => {
    await credited({ payload: payload({ reason: WalletTxnReason.RECHARGE }) });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        type: NotificationType.RECHARGE_SUCCESS,
        entityType: 'wallet_transaction',
        entityId: 'txn-1',
      }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ category: PUSH_CATEGORIES.WALLET }),
    );
  });

  it.each([
    WalletTxnReason.GIFT_REFUND,
    WalletTxnReason.GAME_REFUND,
    WalletTxnReason.LUCKY_PACKET_REFUND,
    WalletTxnReason.CASINO_REFUND,
  ])('maps %s to REFUND_PROCESSED', async (reason) => {
    await credited({ payload: payload({ reason }) });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.REFUND_PROCESSED }),
    );
  });

  it.each([
    WalletTxnReason.ADMIN_CREDIT,
    WalletTxnReason.EVENT_REWARD,
    WalletTxnReason.ATTENDANCE_REWARD,
    WalletTxnReason.SPIN_WHEEL_REWARD,
  ])('maps %s to COINS_RECEIVED', async (reason) => {
    await credited({ payload: payload({ reason }) });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.COINS_RECEIVED }),
    );
  });

  it('maps ADMIN_DEBIT to COINS_DEDUCTED', async () => {
    await debited({ payload: payload({ reason: WalletTxnReason.ADMIN_DEBIT }) });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.COINS_DEDUCTED }),
    );
  });

  // THE regression guard for this whole change. GiftNotificationListener already
  // notifies the receiver on GIFT_EVENTS.SENT. If the wallet listener also fires
  // on the GIFT_RECEIVE movement, every gift on the platform notifies twice.
  it('stays silent on GIFT_RECEIVE — the gift listener already covers it', async () => {
    await credited({ payload: payload({ reason: WalletTxnReason.GIFT_RECEIVE }) });

    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  // Same reasoning: GAME_WON is sent by GameNotificationListener on settlement.
  it('stays silent on GAME_PAYOUT — the games listener already covers it', async () => {
    await credited({ payload: payload({ reason: WalletTxnReason.GAME_PAYOUT }) });

    expect(notifications.create).not.toHaveBeenCalled();
  });

  // WalletTxnReason has 34 members and both events fire on every one of them.
  // Routine play must not generate a notification per movement.
  it.each([
    WalletTxnReason.CASINO_BET,
    WalletTxnReason.GAME_STAKE,
    WalletTxnReason.RESERVATION_HOLD,
    WalletTxnReason.RESERVATION_RELEASE,
    WalletTxnReason.COSMETIC_PURCHASE,
    WalletTxnReason.GIFT_SEND,
    WalletTxnReason.PREMIUM_SEAT,
  ])('stays silent on routine movement %s', async (reason) => {
    await debited({ payload: payload({ reason }) });

    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('dedupes on the transaction id', async () => {
    await credited({ payload: payload() });

    expect(guard.once).toHaveBeenCalledWith(
      'wallet:txn-1',
      expect.any(Number),
      expect.any(Function),
    );
  });

  // A balance is private. The push body must not put it on a lock screen when
  // the user has previews off.
  it('supplies a redacted body that leaks neither amount nor balance', async () => {
    await credited({ payload: payload({ amount: 9999 }) });

    const intent = notifications.notify.mock.calls[0][1] as { redactedBody?: string };
    expect(intent.redactedBody).toBeDefined();
    expect(intent.redactedBody).not.toContain('9999');
  });

  describe('withdrawal decisions', () => {
    const decision = (event: string, body: Record<string, unknown>) => {
      const handler = new Map(bus.subscribe.mock.calls as [string, Handler][]).get(event)!;
      return handler({ payload: body } as never);
    };

    it('notifies on approval', async () => {
      await decision(WITHDRAWAL_EVENTS.APPROVED, {
        withdrawalId: 'w-1',
        userId: USER,
        amount: 5000,
      });

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER,
          type: NotificationType.WITHDRAWAL_APPROVED,
          entityType: 'withdrawal_request',
          entityId: 'w-1',
        }),
      );
    });

    // A rejection without a reason is a support ticket waiting to happen.
    it('carries the reason through on rejection', async () => {
      await decision(WITHDRAWAL_EVENTS.REJECTED, {
        withdrawalId: 'w-2',
        userId: USER,
        amount: 5000,
        reason: 'KYC incomplete',
      });

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.WITHDRAWAL_REJECTED,
          data: expect.objectContaining({ reason: 'KYC incomplete' }),
        }),
      );

      const intent = notifications.notify.mock.calls[0][1] as { body: string };
      expect(intent.body).toContain('KYC incomplete');
    });

    it('dedupes on the withdrawal id', async () => {
      await decision(WITHDRAWAL_EVENTS.APPROVED, {
        withdrawalId: 'w-3',
        userId: USER,
        amount: 100,
      });

      expect(guard.once).toHaveBeenCalledWith(
        'withdrawal:w-3',
        expect.any(Number),
        expect.any(Function),
      );
    });
  });
});
