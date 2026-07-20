import { INFRA_PRESENCE_EVENTS } from 'src/infra/socket/presence.events';
import { VideoRoomPresenceState } from '../enums';
import { VideoRoomPresenceListener } from './video-room-presence.listener';

describe('VideoRoomPresenceListener', () => {
  let handlers: Record<string, (e: any) => void>;
  let bus: any;
  let sessions: any;
  let state: any;
  let events: any;
  let listener: VideoRoomPresenceListener;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, handler: (e: any) => void) => {
        handlers[name] = handler;
        return () => undefined;
      }),
    };
    sessions = {
      listUserSessions: jest.fn().mockResolvedValue(['s1']),
      getSession: jest.fn().mockResolvedValue({ roomId: 'r1', userId: 'u1', socketId: 's1' }),
      markPresence: jest.fn().mockResolvedValue(undefined),
    };
    state = { applyUpdate: jest.fn().mockResolvedValue(undefined) };
    events = { emitUserDisconnected: jest.fn().mockResolvedValue(undefined) };
    listener = new VideoRoomPresenceListener(bus, sessions, state, events);
    listener.onModuleInit();
  });

  it('subscribes to the infra presence-changed event', () => {
    expect(handlers[INFRA_PRESENCE_EVENTS.CHANGED]).toBeDefined();
  });

  it('marks the user sessions DISCONNECTED and publishes UserDisconnected on offline', async () => {
    await handlers[INFRA_PRESENCE_EVENTS.CHANGED]({ payload: { userId: 'u1', online: false } });

    expect(sessions.markPresence).toHaveBeenCalledWith('s1', VideoRoomPresenceState.DISCONNECTED);
    expect(state.applyUpdate).toHaveBeenCalledWith('r1', expect.any(Function));
    expect(events.emitUserDisconnected).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r1',
        userId: 'u1',
        socketId: 's1',
        reason: 'connection_lost',
      }),
    );
  });

  it('ignores the online=true transition (reconnection is handled elsewhere)', async () => {
    await handlers[INFRA_PRESENCE_EVENTS.CHANGED]({ payload: { userId: 'u1', online: true } });
    expect(sessions.markPresence).not.toHaveBeenCalled();
    expect(events.emitUserDisconnected).not.toHaveBeenCalled();
  });
});
