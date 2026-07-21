import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VideoRoomChatSocketListener } from './video-room-chat-socket.listener';

describe('VideoRoomChatSocketListener', () => {
  let handlers: Record<string, (e: unknown) => void>;
  let bus: { subscribe: jest.Mock };
  let sockets: { emitToNamespaceRoom: jest.Mock; emitToUserEverywhere: jest.Mock };
  let listener: VideoRoomChatSocketListener;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, handler: (e: unknown) => void) => {
        handlers[name] = handler;
        return () => undefined;
      }),
    };
    sockets = { emitToNamespaceRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    listener = new VideoRoomChatSocketListener(bus as never, sockets as never);
    listener.onModuleInit();
  });

  it('subscribes to every chat event exactly once', () => {
    const subscribed = Object.keys(handlers).sort();
    expect(subscribed).toEqual(Object.values(VIDEO_ROOM_CHAT_EVENTS).sort());
    expect(bus.subscribe).toHaveBeenCalledTimes(15);
  });

  it('broadcasts a chat-mode change into the room (VR-9.1a)', () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED]({
      payload: { roomId: 'r1', chatMode: 'PARTICIPANTS_ONLY', allowChat: true, slowModeSeconds: 5 },
    });

    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      'video_room.chat_mode_changed',
      { roomId: 'r1', chatMode: 'PARTICIPANTS_ONLY', allowChat: true, slowModeSeconds: 5 },
    );
  });

  it('broadcasts a sent message into the room', () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: { roomId: 'r1', messageId: 'm1' },
    });

    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'r1',
      'video_room.chat_message_sent',
      { roomId: 'r1', messageId: 'm1' },
    );
  });

  it('routes a mention point-to-point, not to the whole room', () => {
    // Broadcasting a mention would tell everyone who was mentioned; each
    // recipient gets their own notice instead.
    handlers[VIDEO_ROOM_CHAT_EVENTS.MENTIONED]({
      payload: { roomId: 'r1', messageId: 'm1', recipientIds: ['u2', 'u3'] },
    });

    expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledTimes(2);
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u2',
      'video_room.chat_mentioned',
      expect.objectContaining({ messageId: 'm1' }),
    );
  });

  it('strips the audit block before it reaches clients', () => {
    // ip / requestId are for the audit trail, not for other room members.
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: { roomId: 'r1', messageId: 'm1', audit: { ip: '10.0.0.1', requestId: 'x' } },
    });

    const payload = sockets.emitToNamespaceRoom.mock.calls[0][3];
    expect(payload.audit).toBeUndefined();
    expect(payload.messageId).toBe('m1');
  });
});
