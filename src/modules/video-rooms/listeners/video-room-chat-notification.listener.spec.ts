import { VideoRoomChatNotificationListener } from './video-room-chat-notification.listener';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const bus = {
    subscribe: (n: string, h: (e: unknown) => void) => {
      handlers[n] = h;
      return () => undefined;
    },
    publish: jest.fn(),
  };
  const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
  new VideoRoomChatNotificationListener(bus as never, dispatcher as never).onModuleInit();
  return { handlers, dispatcher };
}

describe('VideoRoomChatNotificationListener', () => {
  it('announcement → ANNOUNCEMENT to room members', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]({
      payload: {
        roomId: 'r1',
        announcementId: 'a1',
        messageId: 'm1',
        authorId: 'h1',
        content: 'Hello',
        isPinned: true,
      },
    });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(
      K.ANNOUNCEMENT,
      expect.objectContaining({ roomId: 'r1', actorId: 'h1', body: 'Hello' }),
    );
  });

  it('mention → MENTION to each recipient', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_CHAT_EVENTS.MENTIONED]({
      payload: {
        roomId: 'r1',
        messageId: 'm1',
        senderId: 'h1',
        recipientIds: ['u1', 'u2'],
        scope: null,
      },
    });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(
      K.MENTION,
      expect.objectContaining({ targetUserIds: ['u1', 'u2'], actorId: 'h1' }),
    );
  });
});
