import { VideoRoomLifecycleNotificationListener } from './video-room-lifecycle-notification.listener';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
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
  return { handlers, bus, dispatcher };
}

describe('VideoRoomLifecycleNotificationListener', () => {
  it('room started → dispatch ROOM_STARTED to followers with ownerId + occurrenceId', async () => {
    const d = makeDeps();
    new VideoRoomLifecycleNotificationListener(
      d.bus as never,
      d.dispatcher as never,
    ).onModuleInit();
    await d.handlers[VIDEO_ROOM_EVENTS.STARTED]({
      payload: { roomId: 'r1', ownerId: 'o1', actorId: 'o1' },
    });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(
      K.ROOM_STARTED,
      expect.objectContaining({ roomId: 'r1', ownerId: 'o1', occurrenceId: expect.any(String) }),
    );
  });

  it('room closed → dispatch ROOM_CLOSED to room members', async () => {
    const d = makeDeps();
    new VideoRoomLifecycleNotificationListener(
      d.bus as never,
      d.dispatcher as never,
    ).onModuleInit();
    await d.handlers[VIDEO_ROOM_EVENTS.CLOSED]({
      payload: { roomId: 'r1', ownerId: 'o1', actorId: 'o1', durationSeconds: 10 },
    });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(
      K.ROOM_CLOSED,
      expect.objectContaining({ roomId: 'r1' }),
    );
  });
});
