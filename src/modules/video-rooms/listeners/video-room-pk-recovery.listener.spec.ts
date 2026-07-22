import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VideoRoomPkRecoveryListener } from './video-room-pk-recovery.listener';

describe('VideoRoomPkRecoveryListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => Promise<void>> };
  let recovery: { handleHostDrop: jest.Mock; handleHostReturn: jest.Mock };
  let listener: VideoRoomPkRecoveryListener;

  const fire = (name: string, payload: object) => bus.handlers.get(name)!({ name, payload });

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => Promise<void>>();
    bus = {
      handlers,
      subscribe: jest.fn((n: string, f: (e: unknown) => Promise<void>) => handlers.set(n, f)),
    };
    recovery = {
      handleHostDrop: jest.fn().mockResolvedValue(undefined),
      handleHostReturn: jest.fn().mockResolvedValue(undefined),
    };
    listener = new VideoRoomPkRecoveryListener(bus as never, recovery as never);
    listener.onModuleInit();
  });

  it('subscribes to exactly the room-presence disconnect and reconnect events', () => {
    expect(bus.subscribe).toHaveBeenCalledTimes(2);
    expect(bus.handlers.has(VIDEO_ROOM_EVENTS.USER_DISCONNECTED)).toBe(true);
    expect(bus.handlers.has(VIDEO_ROOM_EVENTS.USER_RECONNECTED)).toBe(true);
  });

  it('dispatches a disconnect to handleHostDrop with the room and user', async () => {
    await fire(VIDEO_ROOM_EVENTS.USER_DISCONNECTED, {
      roomId: 'r1',
      userId: 'u1',
      socketId: 's1',
      reason: 'connection_lost',
    });
    expect(recovery.handleHostDrop).toHaveBeenCalledWith('r1', 'u1');
  });

  it('dispatches a reconnect to handleHostReturn with the room and user', async () => {
    await fire(VIDEO_ROOM_EVENTS.USER_RECONNECTED, { roomId: 'r1', userId: 'u1', socketId: 's1' });
    expect(recovery.handleHostReturn).toHaveBeenCalledWith('r1', 'u1');
  });

  // A recovery fault must never break presence handling for the rest of the room.
  it('swallows a handleHostDrop failure instead of throwing', async () => {
    recovery.handleHostDrop.mockRejectedValue(new Error('db down'));
    await expect(
      fire(VIDEO_ROOM_EVENTS.USER_DISCONNECTED, {
        roomId: 'r1',
        userId: 'u1',
        socketId: 's1',
        reason: 'connection_lost',
      }),
    ).resolves.toBeUndefined();
  });

  it('swallows a handleHostReturn failure instead of throwing', async () => {
    recovery.handleHostReturn.mockRejectedValue(new Error('db down'));
    await expect(
      fire(VIDEO_ROOM_EVENTS.USER_RECONNECTED, { roomId: 'r1', userId: 'u1', socketId: 's1' }),
    ).resolves.toBeUndefined();
  });
});
