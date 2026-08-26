import { DirectMessageType, NotificationType } from '@prisma/client';
import { CoinSellerSaleListener } from './coin-seller-sale.listener';

const SALE = { saleId: 'sale-1', sellerId: 'agency-1', buyerId: 'buyer-1', amount: 500 };

describe('CoinSellerSaleListener', () => {
  let bus: { subscribe: jest.Mock; publish: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let profiles: { resolvePublicIdentities: jest.Mock };
  let chat: { openDirect: jest.Mock; sendMessage: jest.Mock };
  let cache: { increment: jest.Mock };
  let listener: CoinSellerSaleListener;
  let handler: (e: { payload: typeof SALE }) => Promise<void>;

  beforeEach(() => {
    bus = { subscribe: jest.fn((_n, fn) => (handler = fn)), publish: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue({}),
      notify: jest.fn().mockResolvedValue(true),
    };
    profiles = {
      resolvePublicIdentities: jest
        .fn()
        .mockResolvedValue(new Map([['agency-1', { displayName: 'Star Agency' }]])),
    };
    chat = {
      openDirect: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      sendMessage: jest.fn().mockResolvedValue({}),
    };
    // 1 = this is the first delivery of the event.
    cache = { increment: jest.fn().mockResolvedValue(1) };

    listener = new CoinSellerSaleListener(
      bus as never,
      notifications as never,
      profiles as never,
      chat as never,
      cache as never,
    );
    listener.onModuleInit();
  });

  it('notifies the buyer, naming the agency', async () => {
    await handler({ payload: SALE });

    const created = notifications.create.mock.calls[0][0];
    expect(created.userId).toBe('buyer-1');
    expect(created.type).toBe(NotificationType.COINS_RECEIVED);
    // The actor is what lets the client show *which* agency sent the coins.
    expect(created.actorId).toBe('agency-1');
    expect(created.data).toMatchObject({ amount: 500, senderName: 'Star Agency' });

    expect(notifications.notify.mock.calls[0][1].body).toBe('Star Agency sent you 500 coins');
  });

  it('does not leak the amount to a lock screen', async () => {
    await handler({ payload: SALE });
    const push = notifications.notify.mock.calls[0][1];
    expect(push.redactedBody).toBe('Your wallet was updated');
    expect(push.redactedBody).not.toContain('500');
  });

  it('writes a SYSTEM receipt into the agency↔buyer thread', async () => {
    await handler({ payload: SALE });

    expect(chat.openDirect).toHaveBeenCalledWith('agency-1', 'buyer-1');
    const [sender, convId, input] = chat.sendMessage.mock.calls[0];
    expect(sender).toBe('agency-1');
    expect(convId).toBe('conv-1');
    expect(input.type).toBe(DirectMessageType.SYSTEM);
    expect(input.content).toBe('Star Agency sent you 500 coins');
    expect(input.metadata).toMatchObject({
      kind: 'coin_seller_sale',
      saleId: 'sale-1',
      amount: 500,
    });
  });

  it('derives clientId from the sale so a retry cannot post two receipts', async () => {
    // Force both deliveries past dedupe: this pins chat's own idempotency,
    // which is the backstop if the Redis guard is ever bypassed.
    cache.increment.mockResolvedValue(1);
    await handler({ payload: SALE });
    await handler({ payload: SALE });
    const ids = chat.sendMessage.mock.calls.map((c) => c[2].clientId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe('coin-seller-sale-sale-1');
  });

  it('dedupes on the sale id', async () => {
    await handler({ payload: SALE });
    expect(cache.increment).toHaveBeenCalledWith(
      'coin-seller-sale:sale-1',
      expect.objectContaining({ by: 1 }),
    );
  });

  it('stays silent on a redelivered event', async () => {
    cache.increment.mockResolvedValue(2);
    await handler({ payload: SALE });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('announces anyway when the dedupe check itself fails', async () => {
    // A duplicate notification beats silently losing the only word the buyer
    // gets that their coins arrived.
    cache.increment.mockRejectedValue(new Error('redis down'));
    await handler({ payload: SALE });
    expect(notifications.create).toHaveBeenCalled();
    expect(chat.sendMessage).toHaveBeenCalled();
  });

  it('falls back to a generic sender rather than a blank name', async () => {
    profiles.resolvePublicIdentities.mockResolvedValue(new Map());
    await handler({ payload: SALE });
    expect(notifications.notify.mock.calls[0][1].body).toBe('An agency sent you 500 coins');
  });

  it('still writes the chat receipt when the notification fails', async () => {
    notifications.create.mockRejectedValue(new Error('inbox down'));
    await expect(handler({ payload: SALE })).resolves.toBeUndefined();
    expect(chat.sendMessage).toHaveBeenCalled();
  });

  it('swallows a chat failure — the coins have already moved', async () => {
    chat.openDirect.mockRejectedValue(new Error('chat down'));
    await expect(handler({ payload: SALE })).resolves.toBeUndefined();
    expect(notifications.create).toHaveBeenCalled();
  });
});
