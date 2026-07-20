import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VideoRoomSeatLifecycleListener } from './video-room-seat-lifecycle.listener';

describe('VideoRoomSeatLifecycleListener', () => {
  let handlers: Record<string, (e: { payload: unknown }) => void>;
  let seatSvc: { onMemberLeave: jest.Mock; onRoomClosed: jest.Mock };

  beforeEach(() => {
    handlers = {};
    const bus = {
      subscribe: (name: string, handler: (e: { payload: unknown }) => void) => {
        handlers[name] = handler;
      },
    };
    seatSvc = { onMemberLeave: jest.fn(), onRoomClosed: jest.fn() };
    new VideoRoomSeatLifecycleListener(bus as never, seatSvc as never).onModuleInit();
  });

  it('vacates a leaving member seat', () => {
    handlers[VIDEO_ROOM_EVENTS.USER_LEFT]({ payload: { roomId: 'r', userId: 'u' } });
    expect(seatSvc.onMemberLeave).toHaveBeenCalledWith('r', 'u');
  });

  it('clears the stage when the room closes or is deleted', () => {
    handlers[VIDEO_ROOM_EVENTS.CLOSED]({ payload: { roomId: 'r' } });
    handlers[VIDEO_ROOM_EVENTS.DELETED]({ payload: { roomId: 'r' } });
    expect(seatSvc.onRoomClosed).toHaveBeenCalledTimes(2);
    expect(seatSvc.onRoomClosed).toHaveBeenCalledWith('r');
  });
});
