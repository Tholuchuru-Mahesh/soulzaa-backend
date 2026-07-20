import {
  videoRoomMediaStateKey,
  videoRoomMediaLockKey,
  videoRoomMediaHeartbeatKey,
  videoRoomMediaRecoveryKey,
  VIDEO_ROOM_SOCKET_EVENTS,
  VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY,
} from './video-room.constants';

describe('VR-5 media constants', () => {
  it('hash-tags the room id for cluster safety', () => {
    expect(videoRoomMediaStateKey('r1')).toBe('video-room:{r1}:media');
    expect(videoRoomMediaLockKey('r1')).toBe('video-room:media:{r1}');
    expect(videoRoomMediaHeartbeatKey('r1', 'u1')).toBe('video-room:{r1}:media:hb:u1');
    expect(videoRoomMediaRecoveryKey('r1', 'u1')).toBe('video-room:{r1}:media:recovery:u1');
    expect(VIDEO_ROOM_MEDIA_MONITOR_LOCK_KEY).toBe('video-room:media:monitor');
  });
  it('exposes media client socket events', () => {
    expect(VIDEO_ROOM_SOCKET_EVENTS.MEDIA_JOINED).toBe('video_room.media_joined');
    expect(VIDEO_ROOM_SOCKET_EVENTS.CAMERA_ON).toBe('video_room.camera_on');
    expect(VIDEO_ROOM_SOCKET_EVENTS.STREAM_PUBLISHED).toBe('video_room.stream_published');
    expect(VIDEO_ROOM_SOCKET_EVENTS.MEDIA_STATE_SYNC).toBe('video_room.media_state_sync');
  });
});
