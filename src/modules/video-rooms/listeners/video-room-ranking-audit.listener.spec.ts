import { VIDEO_ROOM_RANKING_EVENTS } from '../events/video-room-ranking.events';
import { VideoRoomRankingAuditListener } from './video-room-ranking-audit.listener';

describe('VideoRoomRankingAuditListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => Promise<void>> };
  let events: { appendEvent: jest.Mock };
  let listener: VideoRoomRankingAuditListener;

  const fire = (name: string, payload: object, eventId = 'evt-1') =>
    bus.handlers.get(name)!({ name, payload, eventId });

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => Promise<void>>();
    bus = {
      handlers,
      subscribe: jest.fn((n: string, f: (e: unknown) => Promise<void>) => handlers.set(n, f)),
    };
    events = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    listener = new VideoRoomRankingAuditListener(bus as never, events as never);
    listener.onModuleInit();
  });

  it('subscribes to exactly the four lifecycle events, never the per-dimension movement events', () => {
    expect(bus.subscribe).toHaveBeenCalledTimes(4);
    expect(bus.handlers.has(VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED)).toBe(true);
    expect(bus.handlers.has(VIDEO_ROOM_RANKING_EVENTS.LEADERBOARD_UPDATED)).toBe(true);
    expect(bus.handlers.has(VIDEO_ROOM_RANKING_EVENTS.AGGREGATED)).toBe(true);
    expect(bus.handlers.has(VIDEO_ROOM_RANKING_EVENTS.SNAPSHOT_CREATED)).toBe(true);

    // The per-gift movement events must NOT be audited — auditing those would
    // write a row per gift per dimension, four times gift_transactions' volume.
    expect(bus.handlers.has(VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED)).toBe(false);
    expect(bus.handlers.has(VIDEO_ROOM_RANKING_EVENTS.GIFTER_RANKING_UPDATED)).toBe(false);
    expect(bus.handlers.has(VIDEO_ROOM_RANKING_EVENTS.ROOM_RANKING_UPDATED)).toBe(false);
    expect(bus.handlers.has(VIDEO_ROOM_RANKING_EVENTS.PK_RANKING_UPDATED)).toBe(false);
    expect(bus.handlers.has(VIDEO_ROOM_RANKING_EVENTS.TREASURE_RANKING_UPDATED)).toBe(false);
  });

  it('writes an append-only row keyed on the composed ladder coordinate', async () => {
    await fire(VIDEO_ROOM_RANKING_EVENTS.AGGREGATED, {
      roomId: 'r1',
      scope: 'r:r1',
      dimension: 'hosts',
      period: 'daily',
      dateKey: '20260722',
      entriesWritten: 50,
      sourceRows: 500,
      durationMs: 100,
    });
    expect(events.appendEvent).toHaveBeenCalledWith({
      roomId: 'r1',
      eventType: 'ranking.aggregated',
      referenceId: 'r:r1:hosts:daily:20260722',
      correlationId: 'evt-1',
      actorId: '00000000-0000-0000-0000-000000000000',
      payload: expect.objectContaining({
        scope: 'r:r1',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
        requestId: null,
      }),
    });
  });

  it('maps each lifecycle event to its VideoRoomEvent.eventType', async () => {
    const base = {
      roomId: 'r1',
      scope: 'r:r1',
      dimension: 'hosts',
      period: 'daily',
      dateKey: '20260722',
      entries: [],
    };
    await fire(VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED, base);
    await fire(VIDEO_ROOM_RANKING_EVENTS.LEADERBOARD_UPDATED, base);
    await fire(VIDEO_ROOM_RANKING_EVENTS.SNAPSHOT_CREATED, {
      ...base,
      entriesWritten: 10,
      totalEntries: 10,
      durationMs: 20,
    });
    const eventTypes = events.appendEvent.mock.calls.map((c) => c[0].eventType);
    expect(eventTypes).toEqual([
      'ranking.updated',
      'ranking.leaderboard_changed',
      'ranking.snapshot_created',
    ]);
  });

  it('drops a global-scope event — there is no room to write it against', async () => {
    await fire(VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED, {
      scope: 'g',
      dimension: 'hosts',
      period: 'daily',
      dateKey: '20260722',
      entries: [],
    });
    expect(events.appendEvent).not.toHaveBeenCalled();
  });

  it('preserves a request id when the event carries one', async () => {
    await fire(VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED, {
      roomId: 'r1',
      scope: 'r:r1',
      dimension: 'hosts',
      period: 'daily',
      dateKey: '20260722',
      entries: [],
      requestId: 'req-abc',
    });
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ requestId: 'req-abc' }) }),
    );
  });

  it('swallows an appendEvent rejection rather than poisoning the bus', async () => {
    events.appendEvent.mockRejectedValue(new Error('db down'));
    await expect(
      fire(VIDEO_ROOM_RANKING_EVENTS.AGGREGATED, {
        roomId: 'r1',
        scope: 'r:r1',
        dimension: 'hosts',
        period: 'daily',
        dateKey: '20260722',
        entriesWritten: 1,
        sourceRows: 1,
        durationMs: 1,
      }),
    ).resolves.toBeUndefined();
  });
});
