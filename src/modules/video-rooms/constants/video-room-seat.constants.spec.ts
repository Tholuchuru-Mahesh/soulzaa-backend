import {
  VIDEO_ROOM_RESERVATION_TTL_SECONDS,
  VIDEO_ROOM_SOCKET_EVENTS,
  videoRoomSeatLockKey,
  videoRoomSeatReservationKey,
  videoRoomSeatStateKey,
} from './video-room.constants';

describe('video-room seat constants', () => {
  it('hash-tags the room id so all seat keys land on one Cluster slot', () => {
    expect(videoRoomSeatStateKey('r1')).toBe('video-room:{r1}:seats');
    expect(videoRoomSeatLockKey('r1')).toBe('video-room:seat:{r1}');
    expect(videoRoomSeatReservationKey('r1', 3)).toBe('video-room:{r1}:seat:3:hold');
  });

  it('exposes the seat socket events and a positive reservation TTL', () => {
    expect(VIDEO_ROOM_SOCKET_EVENTS.SEAT_SYNC).toBe('video_room.seat_sync');
    expect(VIDEO_ROOM_SOCKET_EVENTS.SEAT_TRANSFERRED).toBe('video_room.seat_transferred');
    expect(VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_ACCEPTED).toBe(
      'video_room.seat_invitation_accepted',
    );
    expect(VIDEO_ROOM_RESERVATION_TTL_SECONDS).toBeGreaterThan(0);
  });
});
