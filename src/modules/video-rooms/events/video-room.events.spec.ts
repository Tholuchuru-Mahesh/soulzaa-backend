import { VIDEO_ROOM_EVENTS, RoomSettingsUpdatedEvent } from './video-room.events';
import { VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';

describe('VR-17 settings event', () => {
  it('exposes the bus + socket event name', () => {
    expect(VIDEO_ROOM_EVENTS.SETTINGS_UPDATED).toBe('video_room.settings_updated');
    expect(VIDEO_ROOM_SOCKET_EVENTS.SETTINGS_UPDATED).toBe('video_room.settings_updated');
  });

  it('carries the full settings snapshot and the changed keys', () => {
    const event = new RoomSettingsUpdatedEvent({
      roomId: 'room-1',
      actorId: 'user-1',
      changed: ['allowGifts'],
      settings: { allowGifts: false } as never,
    });
    expect(event.name).toBe(VIDEO_ROOM_EVENTS.SETTINGS_UPDATED);
    expect(event.payload.changed).toEqual(['allowGifts']);
    expect(event.payload.roomId).toBe('room-1');
  });
});
