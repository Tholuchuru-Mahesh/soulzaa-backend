import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VideoRoomSocketListener } from './video-room-socket.listener';

describe('VideoRoomSocketListener', () => {
  let handlers: Record<string, (e: any) => void>;
  let bus: any;
  let sockets: any;
  let listener: VideoRoomSocketListener;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, handler: (e: any) => void) => {
        handlers[name] = handler;
        return () => undefined;
      }),
    };
    sockets = { emitToNamespaceRoom: jest.fn() };
    listener = new VideoRoomSocketListener(bus, sockets);
    listener.onModuleInit();
  });

  /** Deliberately not relayed to clients (analytics/monitoring only). */
  const BUS_ONLY: string[] = [
    VIDEO_ROOM_EVENTS.HEARTBEAT_MISSED,
    VIDEO_ROOM_EVENTS.SESSION_CREATED,
    VIDEO_ROOM_EVENTS.SESSION_EXPIRED,
    // VR-15: go-live drives the followers fan-out push (delivered on the
    // /notifications namespace + push), not an in-room /video-room relay.
    VIDEO_ROOM_EVENTS.STARTED,
  ];

  it('subscribes to every client-facing domain event but not the bus-only ones', () => {
    for (const name of Object.values(VIDEO_ROOM_EVENTS)) {
      if (BUS_ONLY.includes(name)) {
        expect(handlers[name]).toBeUndefined();
      } else {
        expect(handlers[name]).toBeDefined();
      }
    }
  });

  it('relays RoomCreated to /video-room as video_room.created', () => {
    handlers[VIDEO_ROOM_EVENTS.CREATED]({ payload: { roomId: 'r1', ownerId: 'o1' } });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.CREATED,
      { roomId: 'r1', ownerId: 'o1' },
    );
  });

  it('maps VIEWER_JOINED to the viewer_connected client event', () => {
    handlers[VIDEO_ROOM_EVENTS.VIEWER_JOINED]({
      payload: { roomId: 'r1', userId: 'u1', viewerCount: 5 },
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.VIEWER_CONNECTED,
      { roomId: 'r1', userId: 'u1', viewerCount: 5 },
    );
  });

  it('maps STREAM_STARTED to the stream_ready client event', () => {
    handlers[VIDEO_ROOM_EVENTS.STREAM_STARTED]({
      payload: { roomId: 'r1', userId: 'u1', mediaRoomId: 'm1' },
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.STREAM_READY,
      { roomId: 'r1', userId: 'u1', mediaRoomId: 'm1' },
    );
  });

  it('relays RoomUpdated to the updated client event', () => {
    handlers[VIDEO_ROOM_EVENTS.UPDATED]({
      payload: { roomId: 'r1', actorId: 'a1', changed: ['name'] },
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.UPDATED,
      { roomId: 'r1', actorId: 'a1', changed: ['name'] },
    );
  });

  it('relays RoomLocked to the locked client event', () => {
    handlers[VIDEO_ROOM_EVENTS.LOCKED]({
      payload: { roomId: 'r1', actorId: 'a1', isLocked: true },
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.LOCKED,
      { roomId: 'r1', actorId: 'a1', isLocked: true },
    );
  });

  it('relays RoomDeleted to the deleted client event', () => {
    handlers[VIDEO_ROOM_EVENTS.DELETED]({
      payload: { roomId: 'r1', actorId: 'a1', ownerId: 'o1' },
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.DELETED,
      { roomId: 'r1', actorId: 'a1', ownerId: 'o1' },
    );
  });

  it('relays RoomRestored on the updated client event (restore is a state change)', () => {
    handlers[VIDEO_ROOM_EVENTS.RESTORED]({
      payload: { roomId: 'r1', actorId: 'a1', ownerId: 'o1' },
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.UPDATED,
      { roomId: 'r1', actorId: 'a1', ownerId: 'o1' },
    );
  });

  // ---- VR-3 member/presence relays ----

  it('relays UserDisconnected to the user_disconnected client event', () => {
    const payload = { roomId: 'r1', userId: 'u1', socketId: 's1', reason: 'connection_lost' };
    handlers[VIDEO_ROOM_EVENTS.USER_DISCONNECTED]({ payload });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.USER_DISCONNECTED,
      payload,
    );
  });

  it('relays UserReconnected to the user_reconnected client event', () => {
    const payload = { roomId: 'r1', userId: 'u1', socketId: 's2' };
    handlers[VIDEO_ROOM_EVENTS.USER_RECONNECTED]({ payload });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.USER_RECONNECTED,
      payload,
    );
  });

  it('relays PresenceUpdated to the presence_updated client event', () => {
    const payload = {
      roomId: 'r1',
      userId: 'u1',
      state: 'RECONNECTING',
      onlineCount: 3,
      reconnectingCount: 1,
      idleCount: 0,
    };
    handlers[VIDEO_ROOM_EVENTS.PRESENCE_UPDATED]({ payload });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.PRESENCE_UPDATED,
      payload,
    );
  });

  it('relays RoomSynchronized on the state_sync client event', () => {
    const payload = { roomId: 'r1', version: 7 };
    handlers[VIDEO_ROOM_EVENTS.ROOM_SYNCHRONIZED]({ payload });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.STATE_SYNC,
      payload,
    );
  });

  // ---- VR-6 viewer mode relays ----

  it('relays ViewerPromoted → viewer_promoted', () => {
    const payload = { roomId: 'r1', userId: 'u1', seatIndex: 3, actorId: 'o1' };
    handlers[VIDEO_ROOM_EVENTS.VIEWER_PROMOTED]({ payload });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.VIEWER_PROMOTED,
      payload,
    );
  });

  it('relays ViewerDemoted → viewer_demoted', () => {
    const payload = { roomId: 'r1', userId: 'u1', actorId: 'o1' };
    handlers[VIDEO_ROOM_EVENTS.VIEWER_DEMOTED]({ payload });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.VIEWER_DEMOTED,
      payload,
    );
  });

  it('relays ViewerPresenceChanged → viewer_presence_changed', () => {
    const payload = { roomId: 'r1', userId: 'u1', status: 'WATCHING', audienceCount: 4 };
    handlers[VIDEO_ROOM_EVENTS.VIEWER_PRESENCE_CHANGED]({ payload });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      VIDEO_ROOM_SOCKET_EVENTS.VIEWER_PRESENCE_CHANGED,
      payload,
    );
  });

  // ---- VR-17 settings relay ----

  it('bridges RoomSettingsUpdatedEvent to video_room.settings_updated', () => {
    const handlers = new Map<string, (e: unknown) => void>();
    const bus = { subscribe: jest.fn((name: string, fn) => handlers.set(name, fn)) };
    const sockets = { emitToNamespaceRoom: jest.fn() };
    new VideoRoomSocketListener(bus as never, sockets as never).onModuleInit();

    const payload = {
      roomId: 'room-1',
      actorId: 'user-1',
      changed: ['allowGifts'],
      settings: { allowGifts: false },
    };
    handlers.get(VIDEO_ROOM_EVENTS.SETTINGS_UPDATED)?.({ payload } as never);

    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      VIDEO_ROOM_NAMESPACE,
      'room-1',
      VIDEO_ROOM_SOCKET_EVENTS.SETTINGS_UPDATED,
      payload,
    );
  });
});
