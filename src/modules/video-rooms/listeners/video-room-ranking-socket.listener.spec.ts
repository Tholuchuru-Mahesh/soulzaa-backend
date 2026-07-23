import { VIDEO_ROOM_RANKING_SOCKET_EVENTS } from '../constants/video-room-ranking.constants';
import { VIDEO_ROOM_RANKING_EVENTS } from '../events/video-room-ranking.events';
import { VideoRoomRankingSocketListener } from './video-room-ranking-socket.listener';

jest.useFakeTimers();

describe('VideoRoomRankingSocketListener', () => {
  let handlers: Record<string, (e: unknown) => void>;
  let bus: { subscribe: jest.Mock };
  let sockets: { emitToNamespaceRoom: jest.Mock };
  let metrics: { incRankingBroadcast: jest.Mock };
  let listener: VideoRoomRankingSocketListener;

  const event = (roomId = 'room-1', dimension = 'hosts') => ({
    payload: {
      scope: `r:${roomId}`,
      dimension,
      period: 'daily',
      dateKey: '20260722',
      roomId,
      entries: [],
    },
  });

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, h: (e: unknown) => void) => {
        handlers[name] = h;
        return () => undefined;
      }),
    };
    sockets = { emitToNamespaceRoom: jest.fn() };
    metrics = { incRankingBroadcast: jest.fn() };
    listener = new VideoRoomRankingSocketListener(
      { get: () => ({}) } as never,
      bus as never,
      sockets as never,
      metrics as never,
    );
    listener.onModuleInit();
  });

  afterEach(() => {
    jest.clearAllTimers();
    listener.onModuleDestroy();
  });

  it('subscribes to every movement event', () => {
    expect(handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED]).toBeDefined();
    expect(handlers[VIDEO_ROOM_RANKING_EVENTS.PK_RANKING_UPDATED]).toBeDefined();
    expect(handlers[VIDEO_ROOM_RANKING_EVENTS.TREASURE_RANKING_UPDATED]).toBeDefined();
  });

  it('does not emit synchronously — the window must elapse first', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
  });

  it('emits once after the window closes', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(1);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/video-room',
      'room-1',
      VIDEO_ROOM_RANKING_SOCKET_EVENTS.HOST_RANK_UPDATED,
      expect.objectContaining({ dimension: 'hosts' }),
    );
  });

  it('increments the ranking-broadcast metric exactly once per flushed slot', () => {
    // A burst on ONE slot still coalesces to a single flush, so it must still
    // only count once — not once per enqueued event.
    for (let i = 0; i < 5; i += 1) {
      handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event('room-1', 'hosts'));
    }
    jest.advanceTimersByTime(1_000);
    expect(metrics.incRankingBroadcast).toHaveBeenCalledTimes(1);

    // A second, distinct slot flushing is a second real broadcast.
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event('room-2', 'hosts'));
    jest.advanceTimersByTime(1_000);
    expect(metrics.incRankingBroadcast).toHaveBeenCalledTimes(2);
  });

  it('does not increment the ranking-broadcast metric for a dropped (no-roomId) event', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED]({
      payload: {
        scope: 'g',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
        entries: [],
      },
    });
    jest.advanceTimersByTime(1_000);
    expect(metrics.incRankingBroadcast).not.toHaveBeenCalled();
  });

  it('collapses a burst on one dimension into a single broadcast', () => {
    for (let i = 0; i < 50; i += 1) {
      handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    }
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(1);
  });

  it('keeps different dimensions in the same room separate', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event('room-1', 'hosts'));
    handlers[VIDEO_ROOM_RANKING_EVENTS.GIFTER_RANKING_UPDATED](event('room-1', 'gifters'));
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(2);
  });

  it('keeps different rooms separate', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event('room-1'));
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event('room-2'));
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh window after one flushes', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    jest.advanceTimersByTime(1_000);
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(2);
  });

  it('ignores an event with no roomId — there is nowhere to send it', () => {
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED]({
      payload: {
        scope: 'g',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
        entries: [],
      },
    });
    jest.advanceTimersByTime(1_000);
    expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
  });

  it('swallows an emit failure rather than poisoning the timer loop', () => {
    sockets.emitToNamespaceRoom.mockImplementation(() => {
      throw new Error('socket gone');
    });
    handlers[VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED](event());
    expect(() => jest.advanceTimersByTime(1_000)).not.toThrow();
    // A throw is not a delivered broadcast — must not be counted as one.
    expect(metrics.incRankingBroadcast).not.toHaveBeenCalled();
  });
});
