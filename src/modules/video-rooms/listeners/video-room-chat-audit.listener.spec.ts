import { VideoRoomLogAction } from '@prisma/client';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VideoRoomChatAuditListener } from './video-room-chat-audit.listener';

describe('VideoRoomChatAuditListener', () => {
  let handlers: Record<string, (e: unknown) => void>;
  let bus: { subscribe: jest.Mock };
  let events: { appendEvent: jest.Mock };
  let rooms: { appendLog: jest.Mock };
  let listener: VideoRoomChatAuditListener;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, handler: (e: unknown) => void) => {
        handlers[name] = handler;
        return () => undefined;
      }),
    };
    events = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    rooms = { appendLog: jest.fn().mockResolvedValue(undefined) };
    listener = new VideoRoomChatAuditListener(bus as never, events as never, rooms as never);
    listener.onModuleInit();
  });

  it('records ip and requestId in the audit payload', async () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: {
        roomId: 'r1',
        messageId: 'm1',
        senderId: 'u1',
        audit: { ip: '10.0.0.1', requestId: 'req-9', userAgent: 'jest' },
      },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });
    await Promise.resolve();

    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r1',
        actorId: 'u1',
        eventType: VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT,
        referenceId: 'm1',
        payload: expect.objectContaining({ ip: '10.0.0.1', requestId: 'req-9' }),
      }),
    );
  });

  it('still records an audit row when no request context was supplied', async () => {
    // Socket-originated and system-generated actions have no HTTP request.
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_PINNED]({
      payload: { roomId: 'r1', messageId: 'm1', pinnedBy: 'u1' },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });
    await Promise.resolve();

    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r1', actorId: 'u1' }),
    );
  });

  it('audits the seven mutating actions the brief requires, plus two log-only announcement actions', () => {
    // 7 event-stream (AUDITED) subscriptions + 2 log-only subscriptions
    // (ANNOUNCEMENT_UPDATED/DELETED, which never wrote to the machine event
    // stream and still don't — see GAP 5 / LOG_ONLY_EVENTS).
    expect(bus.subscribe).toHaveBeenCalledTimes(9);
  });

  // ---- GAP 5 (VR-9.1b): VideoRoomLog for moderator-visible chat actions ----

  it('does not write a log row for MESSAGE_SENT (high-volume, not moderator-visible)', async () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: { roomId: 'r1', messageId: 'm1', senderId: 'u1' },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });
    await Promise.resolve();

    expect(rooms.appendLog).not.toHaveBeenCalled();
  });

  it('does not write a log row for MENTIONED (high-volume, not moderator-visible)', async () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MENTIONED]({
      payload: { roomId: 'r1', messageId: 'm1', senderId: 'u1' },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });
    await Promise.resolve();

    expect(rooms.appendLog).not.toHaveBeenCalled();
  });

  it('writes a moderator-visible MESSAGE_DELETED log row', async () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELETED]({
      payload: { roomId: 'r1', messageId: 'm1', deletedBy: 'mod1', byModerator: true },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });
    await Promise.resolve();

    expect(rooms.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r1',
        actorId: 'mod1',
        action: VideoRoomLogAction.MESSAGE_DELETED,
        metadata: expect.objectContaining({ messageId: 'm1' }),
      }),
    );
  });

  it('writes MESSAGE_PINNED / MESSAGE_UNPINNED log rows', async () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_PINNED]({
      payload: { roomId: 'r1', messageId: 'm1', pinnedBy: 'u1' },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_UNPINNED]({
      payload: { roomId: 'r1', messageId: 'm1', unpinnedBy: 'u2' },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });
    await Promise.resolve();

    expect(rooms.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'u1', action: VideoRoomLogAction.MESSAGE_PINNED }),
    );
    expect(rooms.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'u2', action: VideoRoomLogAction.MESSAGE_UNPINNED }),
    );
  });

  it('logs ANNOUNCEMENT_CREATED as ANNOUNCEMENT_POSTED (the pre-existing, never-written enum value)', async () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]({
      payload: {
        roomId: 'r1',
        announcementId: 'a1',
        messageId: 'm1',
        authorId: 'u1',
        content: 'hi',
        isPinned: false,
      },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });
    await Promise.resolve();

    expect(rooms.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'u1',
        action: VideoRoomLogAction.ANNOUNCEMENT_POSTED,
        metadata: expect.objectContaining({ announcementId: 'a1', messageId: 'm1' }),
      }),
    );
  });

  it('logs ANNOUNCEMENT_UPDATED / ANNOUNCEMENT_DELETED using the actorId field', () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_UPDATED]({
      payload: {
        roomId: 'r1',
        announcementId: 'a1',
        messageId: 'm1',
        actorId: 'mod1',
        content: 'updated',
        isPinned: false,
      },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });
    handlers[VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_DELETED]({
      payload: { roomId: 'r1', announcementId: 'a1', messageId: 'm1', actorId: 'mod1' },
      occurredAt: '2026-07-21T00:00:00.000Z',
    });

    expect(rooms.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'mod1', action: VideoRoomLogAction.ANNOUNCEMENT_UPDATED }),
    );
    expect(rooms.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'mod1', action: VideoRoomLogAction.ANNOUNCEMENT_DELETED }),
    );
    // These two never had an event-stream subscriber, and still don't.
    expect(events.appendEvent).not.toHaveBeenCalled();
  });

  it('logs but does not throw when the VideoRoomLog write fails', async () => {
    rooms.appendLog.mockRejectedValue(new Error('db down'));

    expect(() =>
      handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELETED]({
        payload: { roomId: 'r1', messageId: 'm1', deletedBy: 'mod1' },
        occurredAt: '2026-07-21T00:00:00.000Z',
      }),
    ).not.toThrow();
    await Promise.resolve();
  });
});
