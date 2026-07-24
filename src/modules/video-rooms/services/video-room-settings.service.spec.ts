import { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  SETTINGS_FIELD_PERMISSION,
  WRITABLE_SETTINGS_FIELDS,
  VideoRoomSettingsService,
} from './video-room-settings.service';

describe('VideoRoomSettingsService — permission map', () => {
  it('maps every writable field to a permission', () => {
    for (const field of WRITABLE_SETTINGS_FIELDS) {
      expect(SETTINGS_FIELD_PERMISSION[field]).toBeDefined();
    }
  });

  it('gates chat policy on ROOM_MUTE so moderators can act mid-stream', () => {
    expect(SETTINGS_FIELD_PERMISSION.allowChat).toBe(VideoRoomPermission.ROOM_MUTE);
    expect(SETTINGS_FIELD_PERMISSION.slowModeSeconds).toBe(VideoRoomPermission.ROOM_MUTE);
  });

  it('gates media flags on MANAGE_PARTICIPANTS (MANAGE_MEDIA is deliberately not created)', () => {
    expect(SETTINGS_FIELD_PERMISSION.allowBeauty).toBe(VideoRoomPermission.MANAGE_PARTICIPANTS);
    expect(SETTINGS_FIELD_PERMISSION.allowCameraSwitch).toBe(
      VideoRoomPermission.MANAGE_PARTICIPANTS,
    );
  });

  it('excludes deprecated, deferred and seat-layout fields', () => {
    const excluded = [
      'allowViewerChat',
      'hostSeatCount',
      'guestSeatCount',
      'allowFollow',
      'allowShare',
      'joinApprovalRequired',
      'allowJoinRequest',
      'isRoomMuted',
      'maxDurationMinutes',
    ];
    for (const field of excluded) {
      expect(WRITABLE_SETTINGS_FIELDS).not.toContain(field);
    }
  });

  it('excludes allowScreenShare and allowRecording: VR-17 enforces only the flags with a real service method/route (beauty, camera-switch); screen-share and recording have neither, so shipping them as writable would be a placeholder toggle', () => {
    expect(WRITABLE_SETTINGS_FIELDS).not.toContain('allowScreenShare');
    expect(WRITABLE_SETTINGS_FIELDS).not.toContain('allowRecording');
    expect(WRITABLE_SETTINGS_FIELDS).toHaveLength(11);
  });
});

describe('VideoRoomSettingsService.update — gating', () => {
  const room = { id: 'room-1', ownerId: 'owner-1' };
  let rooms: { findById: jest.Mock; getSettings: jest.Mock; updateSettings: jest.Mock };
  let permissions: { assertPermission: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomSettingsService;

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue(room),
      getSettings: jest.fn().mockResolvedValue({ roomId: 'room-1' }),
      updateSettings: jest.fn().mockResolvedValue({ roomId: 'room-1', allowGifts: false }),
    };
    permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new VideoRoomSettingsService(rooms as never, permissions as never, bus as never);
  });

  it('rejects an unknown or deferred field without writing', async () => {
    await expect(
      service.update({ id: 'owner-1', roles: [] }, 'room-1', { maxDurationMinutes: 60 } as never),
    ).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(rooms.updateSettings).not.toHaveBeenCalled();
  });

  it('rejects allowScreenShare and allowRecording: neither has an enforcing service method/route, so they are deferred the same as any other unwritable field', async () => {
    await expect(
      service.update({ id: 'owner-1', roles: [] }, 'room-1', {
        allowScreenShare: true,
        allowRecording: true,
      } as never),
    ).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(rooms.updateSettings).not.toHaveBeenCalled();
  });

  it('asserts every distinct permission implied by the patch', async () => {
    await service.update({ id: 'owner-1', roles: [] }, 'room-1', {
      allowGifts: false,
      allowPk: false,
    });
    const asserted = permissions.assertPermission.mock.calls.map((c) => c[2]);
    expect(asserted).toContain(VideoRoomPermission.MANAGE_TREASURE);
    expect(asserted).toContain(VideoRoomPermission.START_PK);
  });

  it('fails whole: one unauthorized field blocks the entire patch', async () => {
    permissions.assertPermission.mockImplementation((_a, _r, perm) => {
      if (perm === VideoRoomPermission.START_PK) throw new Error('forbidden');
      return Promise.resolve(undefined);
    });
    await expect(
      service.update({ id: 'admin-1', roles: [] }, 'room-1', { allowGifts: false, allowPk: false }),
    ).rejects.toThrow('forbidden');
    expect(rooms.updateSettings).not.toHaveBeenCalled();
  });

  it('a no-op patch writes nothing and publishes nothing', async () => {
    const result = await service.update({ id: 'owner-1', roles: [] }, 'room-1', {});
    expect(rooms.updateSettings).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
    expect(result).toEqual({ roomId: 'room-1' });
  });
});

import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';

describe('VideoRoomSettingsService.update — events', () => {
  const room = { id: 'room-1', ownerId: 'owner-1' };
  let rooms: { findById: jest.Mock; getSettings: jest.Mock; updateSettings: jest.Mock };
  let permissions: { assertPermission: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomSettingsService;

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue(room),
      getSettings: jest.fn().mockResolvedValue({ roomId: 'room-1' }),
      updateSettings: jest.fn().mockResolvedValue({
        roomId: 'room-1',
        allowChat: false,
        slowModeSeconds: 30,
        chatMode: 'NORMAL',
        allowGifts: true,
      }),
    };
    permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new VideoRoomSettingsService(rooms as never, permissions as never, bus as never);
  });

  const publishedNames = () => bus.publish.mock.calls.map((c) => c[0].name);

  it('always publishes the settings event with the full snapshot and changed keys', async () => {
    await service.update({ id: 'owner-1', roles: [] }, 'room-1', { allowGifts: false });
    expect(publishedNames()).toContain(VIDEO_ROOM_EVENTS.SETTINGS_UPDATED);
    const event = bus.publish.mock.calls[0][0];
    expect(event.payload.changed).toEqual(['allowGifts']);
    // Must assert on fields the request delta does NOT carry: if the code ever
    // published `data` (the delta) instead of the post-write row, `allowChat`
    // and `slowModeSeconds` would be absent and this fails. `toBeDefined()` would
    // not have caught it.
    expect(event.payload.settings).toEqual(
      expect.objectContaining({ allowChat: false, slowModeSeconds: 30 }),
    );
    expect(event.payload.actorId).toBe('owner-1');
  });

  it('ADDITIONALLY publishes ChatModeChangedEvent when chat policy is touched', async () => {
    await service.update({ id: 'owner-1', roles: [] }, 'room-1', { slowModeSeconds: 30 });
    expect(bus.publish).toHaveBeenCalledTimes(2);
    expect(publishedNames()[0]).toBe(VIDEO_ROOM_EVENTS.SETTINGS_UPDATED);
    expect(publishedNames()[1]).toBe(VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED);
  });

  it('does NOT publish ChatModeChangedEvent for a non-chat patch', async () => {
    await service.update({ id: 'owner-1', roles: [] }, 'room-1', { allowGifts: false });
    expect(publishedNames()).not.toContain(VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED);
  });
});
