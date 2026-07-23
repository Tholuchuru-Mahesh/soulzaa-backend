import {
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_GUEST_LIMIT,
  VIDEO_ROOM_RANKING_JOBS,
  VIDEO_ROOM_RANKING_NAMESPACE,
  VIDEO_ROOM_RANKING_SOCKET_EVENTS,
  isRankingDimension,
  parseScope,
  scopeCity,
  scopeCountry,
  scopeGlobal,
  scopeRoom,
} from './video-room-ranking.constants';

describe('video-room ranking constants', () => {
  it('namespaces every key under vrank so it can never collide with rankings:*', () => {
    expect(VIDEO_ROOM_RANKING_NAMESPACE).toBe('vrank');
  });

  describe('scope builders', () => {
    it('builds each scope form', () => {
      expect(scopeGlobal()).toBe('g');
      expect(scopeRoom('abc-123')).toBe('r:abc-123');
      expect(scopeCountry('in')).toBe('c:IN');
      expect(scopeCity('city-9')).toBe('y:city-9');
    });

    it('upper-cases country codes so c:in and c:IN are one ladder', () => {
      expect(scopeCountry('in')).toBe(scopeCountry('IN'));
    });
  });

  describe('parseScope', () => {
    it('round-trips every builder', () => {
      expect(parseScope(scopeGlobal())).toEqual({ kind: 'global' });
      expect(parseScope(scopeRoom('abc-123'))).toEqual({ kind: 'room', id: 'abc-123' });
      expect(parseScope(scopeCountry('IN'))).toEqual({ kind: 'country', id: 'IN' });
      expect(parseScope(scopeCity('city-9'))).toEqual({ kind: 'city', id: 'city-9' });
    });

    it('returns null for anything it did not build', () => {
      expect(parseScope('nonsense')).toBeNull();
      expect(parseScope('r:')).toBeNull();
      expect(parseScope('')).toBeNull();
    });
  });

  describe('isRankingDimension', () => {
    it('accepts known dimensions and rejects the rest', () => {
      expect(isRankingDimension('hosts')).toBe(true);
      expect(isRankingDimension(VideoRoomRankingDimension.TREASURE)).toBe(true);
      expect(isRankingDimension('families')).toBe(false);
      expect(isRankingDimension('')).toBe(false);
    });
  });

  it('names all seven jobs under one prefix', () => {
    const names = Object.values(VIDEO_ROOM_RANKING_JOBS);
    expect(names).toHaveLength(7);
    expect(names.every((n) => n.startsWith('video-room.ranking.'))).toBe(true);
    expect(new Set(names).size).toBe(7);
  });

  it('names all seven socket events under the video_room prefix', () => {
    const names = Object.values(VIDEO_ROOM_RANKING_SOCKET_EVENTS);
    expect(names).toHaveLength(7);
    expect(names.every((n) => n.startsWith('video_room.'))).toBe(true);
    expect(new Set(names).size).toBe(7);
  });

  it('caps guests at the top ten', () => {
    expect(VIDEO_ROOM_RANKING_GUEST_LIMIT).toBe(10);
  });
});
