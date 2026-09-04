import { VideoRoomChatMode } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomChatSettingsService } from './video-room-chat-settings.service';

const ACTOR = { id: 'owner-1', roles: [] };
const ROOM = { id: 'r1', ownerId: 'owner-1' };
const SETTINGS = {
  roomId: 'r1',
  allowChat: true,
  allowViewerChat: true,
  chatMode: VideoRoomChatMode.NORMAL,
  slowModeSeconds: 0,
  chatMaxMessageLength: 500,
  chatMaxAttachments: 1,
  chatRateLimitPerMinute: 20,
};

describe('VideoRoomChatSettingsService', () => {
  let permissions: { assertPermission: jest.Mock };
  let rooms: { findById: jest.Mock; getSettings: jest.Mock; updateSettings: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomChatSettingsService;

  beforeEach(() => {
    permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    rooms = {
      findById: jest.fn().mockResolvedValue(ROOM),
      getSettings: jest.fn().mockResolvedValue(SETTINGS),
      updateSettings: jest.fn().mockImplementation((_roomId, data) => ({ ...SETTINGS, ...data })),
    };
    bus = { publish: jest.fn() };
    service = new VideoRoomChatSettingsService(rooms as never, permissions as never, bus as never);
  });

  it('asserts MANAGE_ROOM before touching the repository', async () => {
    permissions.assertPermission.mockRejectedValue(new Error('denied'));

    await expect(service.update(ACTOR, 'r1', { allowChat: false })).rejects.toThrow('denied');

    expect(rooms.updateSettings).not.toHaveBeenCalled();
    expect(rooms.getSettings).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
    expect(permissions.assertPermission).toHaveBeenCalledWith(ACTOR, ROOM, 'MANAGE_ROOM');
  });

  it('404s when the room does not exist', async () => {
    rooms.findById.mockResolvedValue(null);

    await expect(service.update(ACTOR, 'missing', { allowChat: false })).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
    });
    expect(permissions.assertPermission).not.toHaveBeenCalled();
    expect(rooms.updateSettings).not.toHaveBeenCalled();
  });

  it('mirrors allowViewerChat=false in the SAME payload as chatMode=PARTICIPANTS_ONLY', async () => {
    await service.update(ACTOR, 'r1', { chatMode: VideoRoomChatMode.PARTICIPANTS_ONLY });

    expect(rooms.updateSettings).toHaveBeenCalledWith('r1', {
      chatMode: VideoRoomChatMode.PARTICIPANTS_ONLY,
      allowViewerChat: false,
    });
  });

  it.each([
    VideoRoomChatMode.NORMAL,
    VideoRoomChatMode.READ_ONLY,
    VideoRoomChatMode.ANNOUNCEMENT_ONLY,
  ])('mirrors allowViewerChat=true for chatMode=%s', async (chatMode) => {
    await service.update(ACTOR, 'r1', { chatMode });

    expect(rooms.updateSettings).toHaveBeenCalledWith('r1', {
      chatMode,
      allowViewerChat: true,
    });
  });

  it('does not touch allowViewerChat when only slowModeSeconds changes', async () => {
    await service.update(ACTOR, 'r1', { slowModeSeconds: 10 });

    expect(rooms.updateSettings).toHaveBeenCalledWith('r1', { slowModeSeconds: 10 });
    const data = rooms.updateSettings.mock.calls[0][1];
    expect(data).not.toHaveProperty('allowViewerChat');
  });

  it('publishes ChatModeChangedEvent after the write, with the right payload', async () => {
    rooms.updateSettings.mockResolvedValue({
      ...SETTINGS,
      chatMode: VideoRoomChatMode.PARTICIPANTS_ONLY,
      allowViewerChat: false,
      allowChat: true,
      slowModeSeconds: 3,
    });

    await service.update(ACTOR, 'r1', {
      chatMode: VideoRoomChatMode.PARTICIPANTS_ONLY,
      slowModeSeconds: 3,
    });

    expect(bus.publish).toHaveBeenCalledTimes(1);
    const event = bus.publish.mock.calls[0][0];
    expect(event.name).toBe('video_room.chat_mode_changed');
    expect(event.payload).toEqual({
      roomId: 'r1',
      chatMode: VideoRoomChatMode.PARTICIPANTS_ONLY,
      allowChat: true,
      slowModeSeconds: 3,
      // The composer's ceiling rides the same broadcast, so a client
      // retunes the moment it changes.
      chatMaxMessageLength: SETTINGS.chatMaxMessageLength,
      actorId: 'owner-1',
    });
  });

  it('publishes when only allowChat changes (no chatMode in the patch)', async () => {
    rooms.updateSettings.mockResolvedValue({ ...SETTINGS, allowChat: false });

    await service.update(ACTOR, 'r1', { allowChat: false });

    expect(bus.publish).toHaveBeenCalledTimes(1);
  });

  it('a no-field patch writes nothing and publishes nothing', async () => {
    const result = await service.update(ACTOR, 'r1', {});

    expect(rooms.updateSettings).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
    expect(rooms.getSettings).toHaveBeenCalledWith('r1');
    expect(result).toEqual(SETTINGS);
  });

  it('does not publish for a chatMaxAttachments-only patch (not a mode/enable/slow-mode field)', async () => {
    await service.update(ACTOR, 'r1', { chatMaxAttachments: 3 });

    expect(rooms.updateSettings).toHaveBeenCalledWith('r1', { chatMaxAttachments: 3 });
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('carries the audit context onto the published event', async () => {
    const audit = { ip: '1.2.3.4', requestId: 'req-1', userAgent: 'jest' };

    await service.update(ACTOR, 'r1', { allowChat: false }, audit);

    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ audit }) }),
    );
  });
});
