import { VideoRoomNotificationSocketListener } from './video-room-notification-socket.listener';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VIDEO_ROOM_NOTIFICATION_SOCKET_EVENTS } from '../constants/video-room-notification.constants';
import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';

describe('VideoRoomNotificationSocketListener', () => {
  it('emits an in-room announcement banner on the /video-room namespace', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const bus = {
      subscribe: (n: string, h: (e: unknown) => void) => {
        handlers[n] = h;
        return () => undefined;
      },
      publish: jest.fn(),
    };
    const sockets = { emitToNamespaceRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    new VideoRoomNotificationSocketListener(bus as never, sockets as never).onModuleInit();

    handlers[VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]({
      payload: {
        roomId: 'r1',
        announcementId: 'a1',
        messageId: 'm1',
        authorId: 'h1',
        content: 'Hi',
        isPinned: false,
      },
    });

    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      SOCKET_NAMESPACES.VIDEO_ROOM,
      'r1',
      VIDEO_ROOM_NOTIFICATION_SOCKET_EVENTS.ANNOUNCEMENT,
      expect.objectContaining({ content: 'Hi' }),
    );
  });
});
