import { VideoRoomMediaLifecycleListener } from './video-room-media-lifecycle.listener';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';

function makeListener() {
  const handlers: Record<string, (e: unknown) => Promise<void>> = {};
  const bus = {
    subscribe: (name: string, h: (e: unknown) => Promise<void>) => {
      handlers[name] = h;
      return () => {};
    },
  };
  const media = { leaveMedia: jest.fn() };
  const mediaState = {
    clear: jest.fn(),
    getSnapshot: jest.fn().mockResolvedValue({ version: 3, participants: [] }),
  };
  const events = { saveSnapshot: jest.fn() };
  const listener = new VideoRoomMediaLifecycleListener(
    bus as never,
    media as never,
    mediaState as never,
    events as never,
  );
  listener.onModuleInit();
  return { handlers, bus, media, mediaState, events };
}

describe('VideoRoomMediaLifecycleListener', () => {
  it('clears the media stage on room close', async () => {
    const { handlers, events, mediaState } = makeListener();
    await handlers[VIDEO_ROOM_EVENTS.CLOSED]({ payload: { roomId: 'r' } });
    expect(events.saveSnapshot).toHaveBeenCalled();
    expect(mediaState.clear).toHaveBeenCalledWith('r');
  });

  it('snapshots with PRE_SHUTDOWN reason and the current version, then clears', async () => {
    const { handlers, events, mediaState } = makeListener();
    await handlers[VIDEO_ROOM_EVENTS.CLOSED]({ payload: { roomId: 'r1' } });
    expect(events.saveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r1', version: 3, reason: 'PRE_SHUTDOWN' }),
    );
    expect(mediaState.clear).toHaveBeenCalledWith('r1');
  });

  it('clears the media stage on room delete', async () => {
    const { handlers, events, mediaState } = makeListener();
    await handlers[VIDEO_ROOM_EVENTS.DELETED]({ payload: { roomId: 'r2' } });
    expect(events.saveSnapshot).toHaveBeenCalled();
    expect(mediaState.clear).toHaveBeenCalledWith('r2');
  });

  it('skips the snapshot when there is no live snapshot to persist', async () => {
    const { handlers, events, mediaState } = makeListener();
    mediaState.getSnapshot.mockResolvedValueOnce(null);
    await handlers[VIDEO_ROOM_EVENTS.CLOSED]({ payload: { roomId: 'r3' } });
    expect(events.saveSnapshot).not.toHaveBeenCalled();
    expect(mediaState.clear).toHaveBeenCalledWith('r3');
  });

  it('ends the leaving user media session on USER_LEFT', async () => {
    const { handlers, media } = makeListener();
    await handlers[VIDEO_ROOM_EVENTS.USER_LEFT]({ payload: { roomId: 'r4', userId: 'u1' } });
    expect(media.leaveMedia).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r4');
  });
});
