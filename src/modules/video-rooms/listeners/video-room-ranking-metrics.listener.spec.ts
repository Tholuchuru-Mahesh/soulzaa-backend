import { VIDEO_ROOM_RANKING_EVENTS } from '../events/video-room-ranking.events';
import { VideoRoomRankingMetricsListener } from './video-room-ranking-metrics.listener';

describe('VideoRoomRankingMetricsListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => void> };
  let metrics: Record<string, jest.Mock>;
  let cache: { snapshotCounters: jest.Mock };
  let listener: VideoRoomRankingMetricsListener;

  const fire = (name: string, payload: object) => bus.handlers.get(name)!({ name, payload });

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => void>();
    bus = {
      handlers,
      subscribe: jest.fn((n: string, f: (e: unknown) => void) => handlers.set(n, f)),
    };
    metrics = {
      incRankingUpdate: jest.fn(),
      observeRankingAggregation: jest.fn(),
      observeRankingSnapshot: jest.fn(),
      setRankingLadderSize: jest.fn(),
      incRankingCache: jest.fn(),
    };
    cache = { snapshotCounters: jest.fn().mockReturnValue({ hits: 7, misses: 3 }) };
    listener = new VideoRoomRankingMetricsListener(bus as never, metrics as never, cache as never);
    listener.onModuleInit();
  });

  it.each([
    [VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED, 'vip'],
    [VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED, 'hosts'],
    [VIDEO_ROOM_RANKING_EVENTS.GIFTER_RANKING_UPDATED, 'gifters'],
    [VIDEO_ROOM_RANKING_EVENTS.ROOM_RANKING_UPDATED, 'rooms'],
    [VIDEO_ROOM_RANKING_EVENTS.PK_RANKING_UPDATED, 'pk'],
    [VIDEO_ROOM_RANKING_EVENTS.TREASURE_RANKING_UPDATED, 'treasure'],
  ])('increments incRankingUpdate with the dimension label for %s', (eventName, dimension) => {
    fire(eventName, { scope: 'g', dimension, period: 'daily', dateKey: '20260722', entries: [] });
    expect(metrics.incRankingUpdate).toHaveBeenCalledWith(dimension);
  });

  it('observes aggregation duration in seconds, not milliseconds', () => {
    fire(VIDEO_ROOM_RANKING_EVENTS.AGGREGATED, {
      scope: 'g',
      dimension: 'hosts',
      period: 'daily',
      dateKey: '20260722',
      entriesWritten: 50,
      sourceRows: 500,
      durationMs: 2_500,
    });
    expect(metrics.observeRankingAggregation).toHaveBeenCalledWith('daily', 2.5);
  });

  it('sets the ladder size gauge from the aggregation result', () => {
    fire(VIDEO_ROOM_RANKING_EVENTS.AGGREGATED, {
      scope: 'g',
      dimension: 'hosts',
      period: 'daily',
      dateKey: '20260722',
      entriesWritten: 50,
      sourceRows: 500,
      durationMs: 100,
    });
    expect(metrics.setRankingLadderSize).toHaveBeenCalledWith('hosts', 50);
  });

  it('drains the leaderboard cache counters on every aggregation tick', () => {
    fire(VIDEO_ROOM_RANKING_EVENTS.AGGREGATED, {
      scope: 'g',
      dimension: 'hosts',
      period: 'daily',
      dateKey: '20260722',
      entriesWritten: 50,
      sourceRows: 500,
      durationMs: 100,
    });
    expect(cache.snapshotCounters).toHaveBeenCalledTimes(1);
    expect(metrics.incRankingCache).toHaveBeenCalledWith(7, 3);
  });

  it('observes snapshot duration in seconds, not milliseconds', () => {
    fire(VIDEO_ROOM_RANKING_EVENTS.SNAPSHOT_CREATED, {
      scope: 'g',
      dimension: 'hosts',
      period: 'weekly',
      dateKey: '20260722',
      entriesWritten: 100,
      totalEntries: 100,
      durationMs: 750,
    });
    expect(metrics.observeRankingSnapshot).toHaveBeenCalledWith('weekly', 0.75);
  });

  it('does not subscribe to leaderboard.updated as a per-dimension movement', () => {
    expect(bus.handlers.has(VIDEO_ROOM_RANKING_EVENTS.LEADERBOARD_UPDATED)).toBe(false);
  });

  it('never throws out of a handler', () => {
    metrics.incRankingUpdate.mockImplementation(() => {
      throw new Error('registry exploded');
    });
    expect(() =>
      fire(VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED, {
        scope: 'g',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
        entries: [],
      }),
    ).not.toThrow();
  });

  it('never throws even when the thrown value is not an Error', () => {
    // A bare `(err as Error).message` blows up when `err` is undefined/null,
    // turning this swallow-and-log guard into a NEW throw from inside its own
    // catch block. `errorMessage()` exists to prevent exactly that.
    metrics.incRankingUpdate.mockImplementation(() => {
      throw undefined;
    });
    expect(() =>
      fire(VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED, {
        scope: 'g',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
        entries: [],
      }),
    ).not.toThrow();
  });
});
