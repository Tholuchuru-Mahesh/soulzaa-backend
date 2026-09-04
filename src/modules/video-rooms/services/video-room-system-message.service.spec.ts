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
  let identities: { resolve: jest.Mock };
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
    // Nothing resolvable by default: each naming test seeds what it needs, so
    // the fallback path is what the un-seeded tests exercise.
    identities = { resolve: jest.fn().mockResolvedValue(new Map()) };
    service = new VideoRoomSystemMessageService(
      repo as never,
      cache as never,
      presence as never,
      bus as never,
      config as never,
      identities as never,
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

  // ── {name} substitution ────────────────────────────────────────────────
  //
  // The defect these pin: `SystemMessagePolicy` documented that the service
  // substituted placeholders, but no substitution code existed. Templates were
  // emitted verbatim, so every room rendered the literal "A user joined the
  // room." regardless of who joined.
  describe('naming the subject', () => {
    const contentOf = (): string => repo.createMessage.mock.calls[0]![0].content;

    it('names the joiner from the name the event already resolved', async () => {
      await service.emit('USER_JOINED', 'r1', { userId: 'u2', name: 'Vishnu Kiran Reddy' });
      expect(contentOf()).toBe('Vishnu Kiran Reddy joined the room.');
    });

    it('falls back to the handle when no display name is carried', async () => {
      await service.emit('USER_JOINED', 'r1', { userId: 'u2', username: 'studstudy3441' });
      expect(contentOf()).toBe('studstudy3441 joined the room.');
    });

    it('resolves from the identity cache when the payload carries no name', async () => {
      identities.resolve.mockResolvedValue(new Map([['u2', { displayName: 'Vishnu' }]]));
      await service.emit('USER_LEFT', 'r1', { userId: 'u2' });
      expect(identities.resolve).toHaveBeenCalledWith(['u2']);
      expect(contentOf()).toBe('Vishnu left the room.');
    });

    it('uses a neutral word rather than leaving a dangling placeholder', async () => {
      await service.emit('USER_JOINED', 'r1', { userId: 'u2' });
      expect(contentOf()).toBe('Someone joined the room.');
      expect(contentOf()).not.toContain('{name}');
    });

    it('never renders an email address as a name', async () => {
      await service.emit('USER_JOINED', 'r1', {
        userId: 'u2',
        name: 'vishnu.kiran@example.com',
        username: 'vishnu',
      });
      expect(contentOf()).toBe('vishnu joined the room.');
    });

    it('skips the identity lookup for templates with no placeholder', async () => {
      await service.emit('ROOM_CLOSED', 'r1', { userId: 'u2' });
      expect(contentOf()).toBe('The room has ended.');
      expect(identities.resolve).not.toHaveBeenCalled();
    });

    it('carries the subject id so clients can resolve a fresher name', async () => {
      await service.emit('USER_JOINED', 'r1', { userId: 'u2', name: 'Vishnu' });
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ subjectUserId: 'u2' }),
        }),
      );
    });
  });
});
