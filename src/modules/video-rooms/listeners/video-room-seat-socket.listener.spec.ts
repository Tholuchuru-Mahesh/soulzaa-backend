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

describe('VideoRoomSeatSocketListener — VR-8 status routing', () => {
  let deps: any;
  let handlers: Record<string, (e: any) => void>;

  const fire = (type: string, payload: any) => handlers[type]({ payload });
  const emitted = () => deps.sockets.emitToNamespaceRoom.mock.calls.map((c: any[]) => c[2]);

  beforeEach(() => {
    handlers = {};
    deps = {
      bus: {
        subscribe: jest.fn((t: string, fn: (e: any) => void) => {
          handlers[t] = fn;
        }),
      },
      sockets: { emitToNamespaceRoom: jest.fn() },
    };
    new VideoRoomSeatSocketListener(deps.bus, deps.sockets).onModuleInit();
  });

  describe('request resolutions map to distinct events', () => {
    it.each([
      ['ACCEPTED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_APPROVED],
      ['PROMOTED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_APPROVED],
      ['REJECTED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED],
      ['FAILED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_FAILED],
      ['CANCELLED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_CANCELLED],
      ['EXPIRED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_EXPIRED],
    ])('routes %s to %s', (status, expected) => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status });
      expect(emitted()).toEqual([expected]);
    });

    it('REGRESSION: a cancelled request is never announced as rejected', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'CANCELLED' });
      expect(emitted()).not.toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED);
    });

    it('REGRESSION: an expired request is never announced as rejected', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'EXPIRED' });
      expect(emitted()).not.toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED);
    });

    it('REGRESSION: a successful promotion is never announced as rejected', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'PROMOTED' });
      expect(emitted()).not.toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED);
    });

    it('REGRESSION: a failed seating attempt is never announced as a rejection', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'FAILED' });
      expect(emitted()).not.toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED);
      expect(emitted()).toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_FAILED);
    });

    it('emits nothing for a status it does not recognise', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'WAT' });
      expect(deps.sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
    });
  });

  describe('invitation resolutions map to distinct events', () => {
    it.each([
      ['ACCEPTED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_ACCEPTED],
      ['REJECTED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_REJECTED],
      ['FAILED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_FAILED],
      ['CANCELLED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_CANCELLED],
      ['EXPIRED', VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_EXPIRED],
    ])('routes %s to %s', (status, expected) => {
      fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED, { roomId: 'r1', status });
      expect(emitted()).toEqual([expected]);
    });

    it('REGRESSION: a cancelled invitation is never announced as rejected', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED, { roomId: 'r1', status: 'CANCELLED' });
      expect(emitted()).not.toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_REJECTED);
    });

    it('REGRESSION: a failed seating attempt is never announced as an invitee decline', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED, { roomId: 'r1', status: 'FAILED' });
      expect(emitted()).not.toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_REJECTED);
      expect(emitted()).toContain(VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_FAILED);
    });
  });

  describe('the four new events', () => {
    it('bridges a request expiry', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED, { roomId: 'r1', requestId: 'q1', userId: 'u1' });
      expect(emitted()).toEqual([VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_EXPIRED]);
    });

    it('bridges an invitation expiry', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED, {
        roomId: 'r1',
        invitationId: 'i1',
        inviteeUserId: 'u2',
      });
      expect(emitted()).toEqual([VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_EXPIRED]);
    });

    it('bridges an invitation delivery ack', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED, { roomId: 'r1', invitationId: 'i1' });
      expect(emitted()).toEqual([VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_DELIVERED]);
    });

    it('bridges a queue update', () => {
      fire(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED, { roomId: 'r1', size: 3, top: [] });
      expect(emitted()).toEqual([VIDEO_ROOM_SOCKET_EVENTS.SEAT_QUEUE_UPDATED]);
    });
  });
});
