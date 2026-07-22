import { PkEndedEvent, PkScoreUpdatedEvent, VIDEO_ROOM_PK_EVENTS } from './video-room-pk.events';

describe('video-room PK events', () => {
  it('declares 12 event names, all namespaced', () => {
    const names = Object.values(VIDEO_ROOM_PK_EVENTS);
    expect(names).toHaveLength(12);
    expect(names.every((n) => n.startsWith('video_room.pk.'))).toBe(true);
    expect(new Set(names).size).toBe(12);
  });

  it('binds each class to its declared name', () => {
    const e = new PkEndedEvent({
      roomId: 'r',
      battleId: 'b',
      winningTeamId: 't',
      isDraw: false,
      teams: [],
      durationSeconds: 300,
      giftCount: 4,
      totalBase: 100,
    });
    expect(e.name).toBe(VIDEO_ROOM_PK_EVENTS.ENDED);
  });

  it('carries roomId and battleId on every payload', () => {
    const e = new PkScoreUpdatedEvent({
      roomId: 'r',
      battleId: 'b',
      side: 'RED',
      teams: [],
      participantId: 'p',
      userId: 'u',
      scoredAmount: 10,
      multiplierBps: 10_000,
    });
    expect(e.payload.roomId).toBe('r');
    expect(e.payload.battleId).toBe('b');
  });
});
