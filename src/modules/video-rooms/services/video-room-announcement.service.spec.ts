import { VideoRoomMessageType } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomAnnouncementService } from './video-room-announcement.service';

const ACTOR = { id: 'u1', roles: [] };
const ROOM = { id: 'r1', ownerId: 'owner-1' };
const ANN = { id: 'a1', roomId: 'r1', authorId: 'u1', content: 'hello', isPinned: false };

describe('VideoRoomAnnouncementService', () => {
  let permissions: { assertPermission: jest.Mock };
  let rooms: { findById: jest.Mock };
  let events: Record<string, jest.Mock>;
  let chat: Record<string, jest.Mock>;
  let pins: { pin: jest.Mock; unpin: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomAnnouncementService;

  beforeEach(() => {
    permissions = { assertPermission: jest.fn() };
    rooms = { findById: jest.fn().mockResolvedValue(ROOM) };
    events = {
      createAnnouncement: jest.fn().mockResolvedValue(ANN),
      listAnnouncements: jest.fn().mockResolvedValue([ANN]),
      updateAnnouncement: jest.fn().mockResolvedValue({ ...ANN, content: 'edited' }),
      softDeleteAnnouncement: jest.fn().mockResolvedValue(ANN),
    };
    chat = {
      createMessage: jest.fn().mockResolvedValue({ id: 'm1', createdAt: new Date() }),
      editMessage: jest.fn(),
      softDeleteMessage: jest.fn(),
      findByAnnouncementId: jest.fn().mockResolvedValue({ id: 'm1' }),
    };
    pins = { pin: jest.fn(), unpin: jest.fn() };
    bus = { publish: jest.fn() };
    service = new VideoRoomAnnouncementService(
      permissions as never,
      rooms as never,
      events as never,
      chat as never,
      pins as never,
      bus as never,
    );
  });

  it('requires MANAGE_ANNOUNCEMENTS', async () => {
    permissions.assertPermission.mockRejectedValue(new Error('denied'));
    await expect(service.create(ACTOR as never, 'r1', { content: 'x' })).rejects.toThrow('denied');
    expect(events.createAnnouncement).not.toHaveBeenCalled();
  });

  it('writes the announcement row first, then projects a stream message linked back to it', async () => {
    await service.create(ACTOR as never, 'r1', { content: 'hello' });

    expect(events.createAnnouncement.mock.invocationCallOrder[0]).toBeLessThan(
      chat.createMessage.mock.invocationCallOrder[0],
    );
    expect(chat.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r1',
        type: VideoRoomMessageType.ANNOUNCEMENT,
        content: 'hello',
        metadata: { announcementId: 'a1' },
      }),
    );
  });

  it('pins the projected message when isPinned is set', async () => {
    await service.create(ACTOR as never, 'r1', { content: 'hello', isPinned: true });
    expect(pins.pin).toHaveBeenCalledWith(ACTOR, 'r1', 'm1', undefined);
  });

  it('publishes the created event carrying both ids', async () => {
    await service.create(ACTOR as never, 'r1', { content: 'hello' });

    const event = bus.publish.mock.calls[0][0];
    expect(event.name).toBe('video_room.chat_announcement_created');
    expect(event.payload).toMatchObject({ announcementId: 'a1', messageId: 'm1' });
  });

  it('keeps the projected message in sync on update', async () => {
    events.listAnnouncements.mockResolvedValue([ANN]);
    await service.update(ACTOR as never, 'r1', 'a1', { content: 'edited' });

    expect(events.updateAnnouncement).toHaveBeenCalled();
    expect(chat.editMessage).toHaveBeenCalledWith('m1', 'edited');
  });

  it('soft-deletes the projected message when the announcement is removed', async () => {
    await service.remove(ACTOR as never, 'r1', 'a1');

    expect(events.softDeleteAnnouncement).toHaveBeenCalledWith('a1', 'u1');
    expect(chat.softDeleteMessage).toHaveBeenCalledWith('m1', 'u1');
  });

  it('404s on an announcement from another room', async () => {
    events.listAnnouncements.mockResolvedValue([]);
    await expect(
      service.update(ACTOR as never, 'r1', 'missing', { content: 'x' }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_ANNOUNCEMENT_NOT_FOUND });
  });

  it('survives a missing projection — the announcement table is the record of truth', async () => {
    // A lost projection is cosmetic, never data loss. It must not block the
    // announcement's own lifecycle.
    service = new VideoRoomAnnouncementService(
      permissions as never,
      rooms as never,
      {
        ...events,
        listAnnouncements: jest.fn().mockResolvedValue([{ ...ANN, messageId: null }]),
      } as never,
      { ...chat, findByAnnouncementId: jest.fn().mockResolvedValue(null) } as never,
      pins as never,
      bus as never,
    );

    await expect(service.remove(ACTOR as never, 'r1', 'a1')).resolves.toBeUndefined();
  });
});
