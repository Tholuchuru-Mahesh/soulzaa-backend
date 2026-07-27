import { NotificationType } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { GIFT_EVENTS } from 'src/modules/gifts/events/gift.events';
import type { IProfileService } from 'src/modules/users/interfaces/profile.interface';
import type { NotificationService } from '../services/notification.service';
import { GiftNotificationListener } from './gift-notification.listener';

const SENDER = 'sender-1';
const RECEIVER = 'receiver-1';

const payload = (overrides: Record<string, unknown> = {}) => ({
  transactionId: 'gtxn-1',
  senderId: SENDER,
  receiverId: RECEIVER,
  giftId: 'gift-1',
  giftName: 'Rose',
  quantity: 1,
  totalCoinValue: 100,
  ...overrides,
});

describe('GiftNotificationListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let profile: { getCards: jest.Mock };
  let listener: GiftNotificationListener;
  let handler: (e: { payload: ReturnType<typeof payload> }) => Promise<void>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    profile = {
      getCards: jest
        .fn()
        .mockResolvedValue([{ username: 'alice', fullName: 'Alice', avatarUrl: null }]),
    };

    listener = new GiftNotificationListener(
      bus as unknown as IEventBus,
      notifications as unknown as NotificationService,
      profile as unknown as IProfileService,
    );
    listener.onModuleInit();

    expect(bus.subscribe).toHaveBeenCalledWith(GIFT_EVENTS.SENT, expect.any(Function));
    handler = bus.subscribe.mock.calls[0][1];
  });

  it('notifies the receiver of a gift from someone else', async () => {
    await handler({ payload: payload() });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: RECEIVER,
        type: NotificationType.GIFT_RECEIVED,
        actorId: SENDER,
      }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(RECEIVER, expect.anything());
  });

  // Self-gifting is fully supported by the gift domain, but it must stay silent
  // here: the sender just tapped send, so an inbox row and a push telling them
  // about their own action is pure self-spam. The room broadcast and animation
  // are the confirmation. See gift-validation.service.ts for the domain rule.
  it('stays silent on a self-gift — no notification row and no push', async () => {
    await handler({ payload: payload({ receiverId: SENDER }) });

    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('does not even look up the profile card for a self-gift', async () => {
    await handler({ payload: payload({ receiverId: SENDER }) });

    expect(profile.getCards).not.toHaveBeenCalled();
  });
});
