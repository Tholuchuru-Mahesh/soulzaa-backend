import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import { VIDEO_ROOM_MEDIA_EVENTS } from '../events/video-room-media.events';
import { VideoRoomMediaSocketListener } from './video-room-media-socket.listener';

describe('VideoRoomMediaSocketListener', () => {
  let handlers: Record<string, (e: { payload: unknown }) => void>;
  let sockets: { emitToNamespaceRoom: jest.Mock };

  beforeEach(() => {
    handlers = {};
    const bus = {
      subscribe: (name: string, handler: (e: { payload: unknown }) => void) => {
        handlers[name] = handler;
        return () => {};
      },
    };
    sockets = { emitToNamespaceRoom: jest.fn() };
    new VideoRoomMediaSocketListener(bus as never, sockets as never).onModuleInit();
  });

  it('bridges camera_enabled → video_room.camera_on', () => {
    handlers[VIDEO_ROOM_MEDIA_EVENTS.CAMERA_ENABLED]({
      payload: { roomId: 'r', userId: 'u', version: 1 },
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      VIDEO_ROOM_NAMESPACE,
      'r',
      VIDEO_ROOM_SOCKET_EVENTS.CAMERA_ON,
      { roomId: 'r', userId: 'u', version: 1 },
    );
  });

  it('maps media_failed → stream_failed', () => {
    handlers[VIDEO_ROOM_MEDIA_EVENTS.MEDIA_FAILED]({
      payload: { roomId: 'r', userId: 'u', version: 2, reason: 'x' },
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      VIDEO_ROOM_NAMESPACE,
      'r',
      VIDEO_ROOM_SOCKET_EVENTS.STREAM_FAILED,
      expect.any(Object),
    );
  });

  it('bridges every remaining media event to its mapped client event', () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      [
        VIDEO_ROOM_MEDIA_EVENTS.SESSION_CREATED,
        VIDEO_ROOM_SOCKET_EVENTS.MEDIA_JOINED,
        { roomId: 'r', userId: 'u', version: 1, seatIndex: 0, role: 'HOST' },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.SESSION_CLOSED,
        VIDEO_ROOM_SOCKET_EVENTS.MEDIA_LEFT,
        { roomId: 'r', userId: 'u', version: 1, durationSeconds: 10 },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.STREAM_PUBLISHED,
        VIDEO_ROOM_SOCKET_EVENTS.STREAM_PUBLISHED,
        { roomId: 'r', userId: 'u', version: 1, streamId: 's', streamState: 'LIVE' },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.STREAM_STOPPED,
        VIDEO_ROOM_SOCKET_EVENTS.STREAM_STOPPED,
        { roomId: 'r', userId: 'u', version: 1, streamId: null },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.STREAM_PAUSED,
        VIDEO_ROOM_SOCKET_EVENTS.STREAM_PAUSED,
        { roomId: 'r', userId: 'u', version: 1 },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.STREAM_RESUMED,
        VIDEO_ROOM_SOCKET_EVENTS.STREAM_RESUMED,
        { roomId: 'r', userId: 'u', version: 1 },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.CAMERA_DISABLED,
        VIDEO_ROOM_SOCKET_EVENTS.CAMERA_OFF,
        { roomId: 'r', userId: 'u', version: 1 },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.MIC_ENABLED,
        VIDEO_ROOM_SOCKET_EVENTS.MIC_ON,
        { roomId: 'r', userId: 'u', version: 1 },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.MIC_DISABLED,
        VIDEO_ROOM_SOCKET_EVENTS.MIC_OFF,
        { roomId: 'r', userId: 'u', version: 1, byAdmin: false },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.SUBSCRIBED,
        VIDEO_ROOM_SOCKET_EVENTS.MEDIA_SUBSCRIBED,
        { roomId: 'r', userId: 'u', version: 1, targetUserId: 't' },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.UNSUBSCRIBED,
        VIDEO_ROOM_SOCKET_EVENTS.MEDIA_UNSUBSCRIBED,
        { roomId: 'r', userId: 'u', version: 1, targetUserId: 't' },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.BEAUTY_CHANGED,
        VIDEO_ROOM_SOCKET_EVENTS.BEAUTY_CHANGED,
        { roomId: 'r', userId: 'u', version: 1, enabled: true, level: 3 },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.QUALITY_CHANGED,
        VIDEO_ROOM_SOCKET_EVENTS.QUALITY_CHANGED,
        { roomId: 'r', userId: 'u', version: 1, profile: 'HD', bitrateKbps: 800 },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.AUDIO_OUTPUT_CHANGED,
        VIDEO_ROOM_SOCKET_EVENTS.AUDIO_OUTPUT_CHANGED,
        { roomId: 'r', userId: 'u', version: 1, output: 'SPEAKER' },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.STREAM_STATE_CHANGED,
        VIDEO_ROOM_SOCKET_EVENTS.STREAM_STATE_CHANGED,
        { roomId: 'r', userId: 'u', version: 1, streamState: 'LIVE' },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.STREAM_RECOVERED,
        VIDEO_ROOM_SOCKET_EVENTS.STREAM_RECOVERED,
        { roomId: 'r', userId: 'u', version: 1, streamId: 's' },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.MEDIA_RECOVERED,
        VIDEO_ROOM_SOCKET_EVENTS.MEDIA_RECOVERED,
        { roomId: 'r', userId: 'u', version: 1 },
      ],
      [
        VIDEO_ROOM_MEDIA_EVENTS.STATE_SYNC,
        VIDEO_ROOM_SOCKET_EVENTS.MEDIA_STATE_SYNC,
        { roomId: 'r', userId: 'u', version: 1 },
      ],
    ];

    for (const [busEvent, clientEvent, payload] of cases) {
      sockets.emitToNamespaceRoom.mockClear();
      handlers[busEvent]({ payload });
      expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
        VIDEO_ROOM_NAMESPACE,
        'r',
        clientEvent,
        payload,
      );
    }
  });

  it('does not subscribe to any heartbeat/quality-sample-only bus names', () => {
    expect(Object.keys(handlers)).toHaveLength(Object.keys(VIDEO_ROOM_MEDIA_EVENTS).length);
  });
});
