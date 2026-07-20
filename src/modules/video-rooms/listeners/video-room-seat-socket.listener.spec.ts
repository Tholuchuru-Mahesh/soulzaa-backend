import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import { VIDEO_ROOM_SEAT_EVENTS } from '../events/video-room-seat.events';
import { VideoRoomSeatSocketListener } from './video-room-seat-socket.listener';

describe('VideoRoomSeatSocketListener', () => {
  let handlers: Record<string, (e: { payload: unknown }) => void>;
  let sockets: { emitToNamespaceRoom: jest.Mock };

  beforeEach(() => {
    handlers = {};
    const bus = {
      subscribe: (name: string, handler: (e: { payload: unknown }) => void) => {
        handlers[name] = handler;
      },
    };
    sockets = { emitToNamespaceRoom: jest.fn() };
    new VideoRoomSeatSocketListener(bus as never, sockets as never).onModuleInit();
  });

  it('bridges seat_taken → video_room.seat_updated', () => {
    handlers[VIDEO_ROOM_SEAT_EVENTS.TAKEN]({
      payload: { roomId: 'r', version: 2, seatIndex: 1, userId: 'u' },
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      VIDEO_ROOM_NAMESPACE,
      'r',
      VIDEO_ROOM_SOCKET_EVENTS.SEAT_UPDATED,
      expect.objectContaining({ seatIndex: 1 }),
    );
  });

  it('branches request resolution: ACCEPTED → approved, REJECTED → rejected', () => {
    handlers[VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED]({
      payload: { roomId: 'r', requestId: 'q', userId: 'u', status: 'ACCEPTED' },
    });
    handlers[VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED]({
      payload: { roomId: 'r', requestId: 'q', userId: 'u', status: 'REJECTED' },
    });
    const events = sockets.emitToNamespaceRoom.mock.calls.map((c) => c[2]);
    expect(events).toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_APPROVED);
    expect(events).toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED);
  });

  it('branches invitation resolution: ACCEPTED → accepted socket event', () => {
    handlers[VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED]({
      payload: { roomId: 'r', invitationId: 'i', inviteeUserId: 'u', status: 'ACCEPTED' },
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      VIDEO_ROOM_NAMESPACE,
      'r',
      VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_ACCEPTED,
      expect.anything(),
    );
  });

  it('bridges seat_locked and seat_transferred to their client events', () => {
    handlers[VIDEO_ROOM_SEAT_EVENTS.LOCKED]({
      payload: { roomId: 'r', version: 3, seatIndex: 2, actorId: 'a', reason: null },
    });
    handlers[VIDEO_ROOM_SEAT_EVENTS.TRANSFERRED]({
      payload: {
        roomId: 'r',
        version: 4,
        userId: 'u',
        fromSeatIndex: 1,
        toSeatIndex: 2,
        actorId: 'a',
        forced: false,
      },
    });
    const events = sockets.emitToNamespaceRoom.mock.calls.map((c) => c[2]);
    expect(events).toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_LOCKED);
    expect(events).toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_TRANSFERRED);
  });
});
