import { VideoRoomChatSystemListener } from './video-room-chat-system.listener';

describe('VideoRoomChatSystemListener', () => {
  let handlers: Record<string, (e: unknown) => void>;
  let bus: { subscribe: jest.Mock };
  let system: { emit: jest.Mock };
  let listener: VideoRoomChatSystemListener;

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, handler: (e: unknown) => void) => {
        handlers[name] = handler;
        return () => undefined;
      }),
    };
    // `VideoRoomSystemMessageService.emit` is async in production; the mock must
    // return a resolved promise so `dispatch`'s `.catch` has something to call.
    system = { emit: jest.fn().mockResolvedValue(undefined) };
    listener = new VideoRoomChatSystemListener(bus as never, system as never);
    listener.onModuleInit();
  });

  it('subscribes to the 11 domain events backing the 13 system-message kinds', () => {
    // LOCKED and REQUEST_RESOLVED are each a single subscription that fans out
    // to more than one kind depending on their payload (see the other tests
    // below), so 11 bus subscriptions cover all 13 SYSTEM_MESSAGE_POLICY kinds.
    expect(bus.subscribe).toHaveBeenCalledTimes(11);
  });

  it('maps a viewer join to VIEWER_JOINED', () => {
    handlers['video_room.viewer_joined']({ payload: { roomId: 'r1', userId: 'u2' } });
    expect(system.emit).toHaveBeenCalledWith('VIEWER_JOINED', 'r1', { userId: 'u2' });
  });

  it('maps ownership transfer to OWNER_CHANGED', () => {
    handlers['video_room.ownership_transferred']({
      payload: { roomId: 'r1', newOwnerId: 'u9', previousOwnerId: 'u1' },
    });
    expect(system.emit).toHaveBeenCalledWith(
      'OWNER_CHANGED',
      'r1',
      expect.objectContaining({ newOwnerId: 'u9' }),
    );
  });

  it('splits the lock event into LOCKED and UNLOCKED by its flag', () => {
    // One bus event carries both states; emitting "locked" for an unlock
    // would tell the room the opposite of what happened.
    handlers['video_room.locked']({ payload: { roomId: 'r1', isLocked: false } });
    expect(system.emit).toHaveBeenCalledWith('ROOM_UNLOCKED', 'r1', expect.any(Object));

    system.emit.mockClear();
    handlers['video_room.locked']({ payload: { roomId: 'r1', isLocked: true } });
    expect(system.emit).toHaveBeenCalledWith('ROOM_LOCKED', 'r1', expect.any(Object));
  });

  it('emits nothing for a seat resolution it has no mapping for', () => {
    handlers['video_room.seat_request_resolved']({
      payload: { roomId: 'r1', status: 'CANCELLED' },
    });
    expect(system.emit).not.toHaveBeenCalled();
  });

  it('maps ACCEPTED and REJECTED seat resolutions', () => {
    handlers['video_room.seat_request_resolved']({
      payload: { roomId: 'r1', status: 'ACCEPTED', userId: 'u2' },
    });
    expect(system.emit).toHaveBeenCalledWith('SEAT_APPROVED', 'r1', expect.any(Object));

    system.emit.mockClear();
    handlers['video_room.seat_request_resolved']({
      payload: { roomId: 'r1', status: 'REJECTED', userId: 'u2' },
    });
    expect(system.emit).toHaveBeenCalledWith('SEAT_REJECTED', 'r1', expect.any(Object));
  });
});
