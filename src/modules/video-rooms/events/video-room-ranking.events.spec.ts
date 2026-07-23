import {
  HostRankingUpdatedEvent,
  RankingAggregatedEvent,
  RankingUpdatedEvent,
  VIDEO_ROOM_RANKING_EVENTS,
} from './video-room-ranking.events';

describe('VR-13 ranking events', () => {
  it('namespaces every event under video_room.ranking / video_room.leaderboard', () => {
    const names = Object.values(VIDEO_ROOM_RANKING_EVENTS);
    expect(names).toHaveLength(9);
    expect(new Set(names).size).toBe(9);
    expect(
      names.every(
        (n) => n.startsWith('video_room.ranking.') || n.startsWith('video_room.leaderboard.'),
      ),
    ).toBe(true);
  });

  it('binds each class to its own bus name', () => {
    const base = { scope: 'g', dimension: 'hosts', period: 'daily', dateKey: '20260722' };
    expect(new RankingUpdatedEvent({ ...base, entries: [] }).name).toBe(
      VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED,
    );
    expect(new HostRankingUpdatedEvent({ ...base, entries: [] }).name).toBe(
      VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED,
    );
  });

  it('carries an eventId and occurredAt from DomainEvent', () => {
    const e = new RankingAggregatedEvent({
      scope: 'g',
      dimension: 'hosts',
      period: 'daily',
      dateKey: '20260722',
      entriesWritten: 12,
      sourceRows: 340,
      durationMs: 88,
    });
    expect(e.eventId).toEqual(expect.any(String));
    expect(Date.parse(e.occurredAt)).not.toBeNaN();
  });

  it('keeps the payload plain-serialisable — no BigInt crosses the bus', () => {
    const e = new RankingUpdatedEvent({
      scope: 'g',
      dimension: 'hosts',
      period: 'daily',
      dateKey: '20260722',
      entries: [{ targetId: 'u1', rank: 1, score: 900 }],
    });
    expect(() => JSON.stringify(e.payload)).not.toThrow();
  });
});
