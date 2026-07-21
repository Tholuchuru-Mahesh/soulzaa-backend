import { VideoRoomMessageType } from '@prisma/client';
import { VideoRoomSystemMessageService } from './video-room-system-message.service';

const CFG = {
  systemMessageBroadcastOnlyAboveViewers: 200,
  systemMessageSuppressAboveViewers: 2000,
};

describe('VideoRoomSystemMessageService', () => {
  let repo: { createMessage: jest.Mock };
  let cache: { pushRecent: jest.Mock };
  let presence: { viewerCount: jest.Mock };
  let bus: { publish: jest.Mock };
  let config: { get: jest.Mock };
  let service: VideoRoomSystemMessageService;

  beforeEach(() => {
    repo = {
      createMessage: jest.fn().mockResolvedValue({
        id: 'm1',
        roomId: 'r1',
        senderId: '00000000-0000-0000-0000-000000000000',
        type: VideoRoomMessageType.SYSTEM,
        content: 'x',
        mentions: [],
        mentionScope: null,
        replyToId: null,
        metadata: { systemEvent: 'USER_JOINED' },
        createdAt: new Date(),
      }),
    };
    cache = { pushRecent: jest.fn() };
    presence = { viewerCount: jest.fn().mockResolvedValue(10) };
    bus = { publish: jest.fn() };
    config = { get: jest.fn().mockReturnValue(CFG) };
    service = new VideoRoomSystemMessageService(
      repo as never,
      cache as never,
      presence as never,
      bus as never,
      config as never,
    );
  });

  it('persists a lifecycle event and broadcasts it', async () => {
    await service.emit('OWNER_CHANGED', 'r1', { newOwnerId: 'u2' });

    expect(repo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VideoRoomMessageType.SYSTEM,
        senderId: '00000000-0000-0000-0000-000000000000',
      }),
    );
    expect(bus.publish).toHaveBeenCalled();
  });

  it('persists a viewer join in a small room', async () => {
    await service.emit('VIEWER_JOINED', 'r1', { userId: 'u2' });
    expect(repo.createMessage).toHaveBeenCalled();
  });

  it('broadcasts but does NOT persist a viewer join in a large room', async () => {
    // Above the threshold a join message is churn, not conversation. Persisting
    // it would leave totalChatMessages measuring turnover instead of chat.
    presence.viewerCount.mockResolvedValue(500);

    await service.emit('VIEWER_JOINED', 'r1', { userId: 'u2' });

    expect(repo.createMessage).not.toHaveBeenCalled();
    expect(bus.publish).toHaveBeenCalled();
  });

  it('suppresses a viewer join entirely in a huge room', async () => {
    presence.viewerCount.mockResolvedValue(5000);

    await service.emit('VIEWER_JOINED', 'r1', { userId: 'u2' });

    expect(repo.createMessage).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('NEVER suppresses a lifecycle event, however large the room', async () => {
    presence.viewerCount.mockResolvedValue(50_000);

    await service.emit('ROOM_CLOSED', 'r1', {});

    expect(repo.createMessage).toHaveBeenCalled();
    expect(bus.publish).toHaveBeenCalled();
  });

  it('ignores an unmapped kind rather than emitting something wrong', async () => {
    await service.emit('NOT_A_REAL_EVENT', 'r1', {});

    expect(repo.createMessage).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('never counts viewers for an always-persist event', async () => {
    await service.emit('SEAT_APPROVED', 'r1', { userId: 'u2' });
    expect(presence.viewerCount).not.toHaveBeenCalled();
  });

  it('marks system messages as SENT', async () => {
    await service.emit('OWNER_CHANGED', 'r1', { newOwnerId: 'u2' });

    const payload = bus.publish.mock.calls[0][0].payload;
    expect(payload.status).toBe('SENT');
  });
});
