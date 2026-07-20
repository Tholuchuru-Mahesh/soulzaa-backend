import {
  VIDEO_ROOM_MEDIA_EVENTS,
  MediaSessionCreatedEvent,
  MediaStreamPublishedEvent,
  CameraEnabledEvent,
} from './video-room-media.events';

describe('VR-5 media events', () => {
  it('event carries its bus name + payload', () => {
    const e = new MediaSessionCreatedEvent({
      roomId: 'r',
      version: 1,
      userId: 'u',
      seatIndex: null,
      role: 'SUBSCRIBER' as never,
    });
    expect(e.name).toBe(VIDEO_ROOM_MEDIA_EVENTS.SESSION_CREATED);
    expect(e.payload.userId).toBe('u');
  });

  it('publish + camera events expose distinct names', () => {
    expect(
      new MediaStreamPublishedEvent({
        roomId: 'r',
        version: 1,
        userId: 'u',
        streamId: 's',
        streamState: 'LIVE' as never,
      }).name,
    ).toBe(VIDEO_ROOM_MEDIA_EVENTS.STREAM_PUBLISHED);
    expect(new CameraEnabledEvent({ roomId: 'r', version: 1, userId: 'u' }).name).toBe(
      VIDEO_ROOM_MEDIA_EVENTS.CAMERA_ENABLED,
    );
  });
});
