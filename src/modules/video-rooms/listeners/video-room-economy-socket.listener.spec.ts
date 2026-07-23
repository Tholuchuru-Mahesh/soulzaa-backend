import { VideoRoomEconomySocketListener } from './video-room-economy-socket.listener';
import {
  VIDEO_ROOM_ECONOMY_EVENTS,
  VIDEO_ROOM_ECONOMY_SOCKET_EVENTS,
} from '../constants/video-room-economy.constants';
import { GIFT_EVENTS } from 'src/modules/gifts/events/gift.events';
import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const bus = {
    subscribe: (n: string, h: (e: unknown) => void) => {
      handlers[n] = h;
      return () => undefined;
    },
    publish: jest.fn(),
  };
  const sockets = { emitToUserEverywhere: jest.fn(), emitToNamespaceRoom: jest.fn() };
  return { handlers, bus, sockets };
}

describe('VideoRoomEconomySocketListener', () => {
  it('bridges VIDEO_ROOM gift.sent to hostEarningUpdated (receiver + room), ignores other contexts', () => {
    const d = makeDeps();
    new VideoRoomEconomySocketListener(d.bus as never, d.sockets as never).onModuleInit();

    d.handlers[GIFT_EVENTS.SENT]({
      payload: {
        contextType: 'AUDIO_ROOM',
        contextId: 'r1',
        receiverId: 'h1',
        creatorEarnings: 10,
      },
    });
    expect(d.sockets.emitToNamespaceRoom).not.toHaveBeenCalled();

    d.handlers[GIFT_EVENTS.SENT]({
      payload: {
        contextType: 'VIDEO_ROOM',
        contextId: 'r1',
        receiverId: 'h1',
        creatorEarnings: 10,
        transactionId: 't1',
      },
    });
    expect(d.sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      SOCKET_NAMESPACES.VIDEO_ROOM,
      'r1',
      VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED,
      expect.any(Object),
    );
    expect(d.sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'h1',
      VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED,
      expect.any(Object),
    );
  });

  it('bridges treasure + pk reward_distributed to rewardReceived', () => {
    const d = makeDeps();
    new VideoRoomEconomySocketListener(d.bus as never, d.sockets as never).onModuleInit();

    d.handlers[VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED]({
      payload: { roomId: 'r1', userId: 'u1', amount: 50, walletTxnId: 'w1' },
    });
    d.handlers[VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED]({
      payload: {
        roomId: 'r1',
        battleId: 'b1',
        rewards: [
          { userId: 'u2', kind: 'WINNER', amount: 100 },
          { userId: 'u3', kind: 'PARTICIPATION', amount: 20 },
        ],
      },
    });

    const rewardCalls = d.sockets.emitToUserEverywhere.mock.calls.filter(
      (c: unknown[]) => c[1] === VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.REWARD_RECEIVED,
    );
    expect(rewardCalls.map((c: unknown[]) => c[0])).toEqual(['u1', 'u2', 'u3']);
  });

  it('bridges GIFT_FAILED to transactionFailed for the affected user', () => {
    const d = makeDeps();
    new VideoRoomEconomySocketListener(d.bus as never, d.sockets as never).onModuleInit();

    d.handlers[VIDEO_ROOM_ECONOMY_EVENTS.GIFT_FAILED]({
      payload: {
        userId: 'u9',
        roomId: 'r1',
        giftId: 'g1',
        errorCode: 'INSUFFICIENT_BALANCE',
        message: 'insufficient balance',
      },
    });

    expect(d.sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u9',
      VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.TRANSACTION_FAILED,
      expect.objectContaining({ roomId: 'r1', giftId: 'g1', errorCode: 'INSUFFICIENT_BALANCE' }),
    );
  });
});
