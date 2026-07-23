import { EventEmitter2 } from '@nestjs/event-emitter';
import { InMemoryEventBus } from 'src/common/events/in-memory-event-bus';
import { WalletRealtimeListener } from 'src/modules/wallet/listeners/wallet-realtime.listener';
import { VideoRoomEconomySocketListener } from './listeners/video-room-economy-socket.listener';
import { WALLET_SOCKET_EVENTS } from 'src/modules/wallet/constants/wallet.constants';
import { VIDEO_ROOM_ECONOMY_SOCKET_EVENTS } from './constants/video-room-economy.constants';
import { WalletCreditedEvent } from 'src/modules/wallet/events/wallet.events';
import { GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { WalletCurrency, WalletTxnReason, GiftContextType, GiftType } from '@prisma/client';

describe('VR-14 wallet integration (event → socket)', () => {
  it('a wallet credit + a VIDEO_ROOM gift.sent fan out to the right sockets', async () => {
    const bus = new InMemoryEventBus(new EventEmitter2({ wildcard: true, delimiter: '.' }));
    const sockets = { emitToUserEverywhere: jest.fn(), emitToNamespaceRoom: jest.fn() };
    const walletSvc = {
      getBalance: jest.fn().mockResolvedValue({ gold: 0, free: 0, earnings: 25 }),
    };
    const metrics = {
      recordMovement: jest.fn(),
      recordFailed: jest.fn(),
      recordReconciliationDrift: jest.fn(),
    };

    const realtime = new WalletRealtimeListener(
      bus as never,
      sockets as never,
      walletSvc as never,
      metrics as never,
    );
    realtime.onModuleInit();
    new VideoRoomEconomySocketListener(bus as never, sockets as never).onModuleInit();

    await bus.publish(
      new WalletCreditedEvent({
        userId: 'host1',
        transactionId: 'w1',
        currency: WalletCurrency.EARNINGS,
        amount: 25,
        balanceAfter: 25,
        reason: WalletTxnReason.GIFT_RECEIVE,
        referenceType: 'gift',
        referenceId: null,
      }),
    );
    await realtime.flush('host1');

    await bus.publish(
      new GiftSentEvent({
        transactionId: 'g1',
        senderId: 's1',
        receiverId: 'host1',
        giftId: 'gift1',
        giftType: GiftType.STATIC,
        giftName: 'Rose',
        contextType: GiftContextType.VIDEO_ROOM,
        contextId: 'room1',
        quantity: 1,
        comboTier: 1,
        unitCoinValue: 100,
        totalCoinValue: 100,
        creatorEarnings: 25,
        luckyMultiplier: 1,
        isLuckyWin: false,
        senderExp: 0,
        receiverExp: 0,
        createdAt: new Date().toISOString(),
      }),
    );

    const evts = sockets.emitToUserEverywhere.mock.calls.map((c: unknown[]) => c[1]);
    expect(evts).toContain(WALLET_SOCKET_EVENTS.TRANSACTION_COMPLETED);
    expect(evts).toContain(WALLET_SOCKET_EVENTS.BALANCE_CHANGED);
    expect(evts).toContain(VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'room1',
      VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED,
      expect.any(Object),
    );
  });
});
