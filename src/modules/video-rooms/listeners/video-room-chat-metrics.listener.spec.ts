import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VideoRoomChatMetricsListener } from './video-room-chat-metrics.listener';

describe('VideoRoomChatMetricsListener', () => {
  let handlers: Record<string, (e: unknown) => void>;
  let bus: { subscribe: jest.Mock };
  let metrics: Record<string, jest.Mock>;
  let rooms: { bumpChatMessageCount: jest.Mock };
  let listener: VideoRoomChatMetricsListener;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, handler: (e: unknown) => void) => {
        handlers[name] = handler;
        return () => undefined;
      }),
    };
    metrics = {
      incChatMessage: jest.fn(),
      observeChatLatency: jest.fn(),
      observeChatDelivery: jest.fn(),
      observeChatRead: jest.fn(),
      incTypingEvent: jest.fn(),
      incAnnouncement: jest.fn(),
    };
    rooms = { bumpChatMessageCount: jest.fn().mockResolvedValue(undefined) };
    listener = new VideoRoomChatMetricsListener(bus as never, metrics as never, rooms as never);
    listener.onModuleInit();
  });

  it('counts a sent message by type', () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: { roomId: 'r1', type: 'TEXT', createdAt: new Date().toISOString() },
      occurredAt: new Date().toISOString(),
    });
    expect(metrics.incChatMessage).toHaveBeenCalledWith('TEXT');
    expect(metrics.observeChatLatency).toHaveBeenCalled();
  });

  it('bumps the chat message counter for a real user message', async () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: { roomId: 'r1', type: 'TEXT', createdAt: new Date().toISOString() },
      occurredAt: new Date().toISOString(),
    });
    await Promise.resolve();

    expect(rooms.bumpChatMessageCount).toHaveBeenCalledWith('r1');
  });

  it('skips the bump for SYSTEM rows so presence churn is not counted', async () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: { roomId: 'r1', type: 'SYSTEM', createdAt: new Date().toISOString() },
      occurredAt: new Date().toISOString(),
    });
    await Promise.resolve();

    expect(rooms.bumpChatMessageCount).not.toHaveBeenCalled();
  });

  it('logs but does not throw when the stats bump fails', async () => {
    rooms.bumpChatMessageCount.mockRejectedValue(new Error('db down'));

    expect(() =>
      handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
        payload: { roomId: 'r1', type: 'TEXT', createdAt: new Date().toISOString() },
        occurredAt: new Date().toISOString(),
      }),
    ).not.toThrow();
    await Promise.resolve();
  });

  it('observes read latency from message creation to receipt', () => {
    const created = new Date('2026-07-21T10:00:00Z').toISOString();
    handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_READ]({
      payload: { roomId: 'r1', at: created },
      occurredAt: new Date('2026-07-21T10:00:30Z').toISOString(),
    });
    expect(metrics.observeChatRead).toHaveBeenCalledWith(30);
  });

  it('labels announcement actions distinctly', () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]({ payload: { roomId: 'r1' } });
    handlers[VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_DELETED]({ payload: { roomId: 'r1' } });
    expect(metrics.incAnnouncement).toHaveBeenCalledWith('created');
    expect(metrics.incAnnouncement).toHaveBeenCalledWith('deleted');
  });

  it('counts both typing directions', () => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.TYPING_STARTED]({ payload: { roomId: 'r1' } });
    handlers[VIDEO_ROOM_CHAT_EVENTS.TYPING_STOPPED]({ payload: { roomId: 'r1' } });
    expect(metrics.incTypingEvent).toHaveBeenCalledTimes(2);
  });
});
