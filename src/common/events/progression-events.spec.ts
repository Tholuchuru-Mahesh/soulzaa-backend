import { PROGRESSION_EVENT_NAMES, resolveProgressionSubject } from './progression-events';

describe('progression event bridge', () => {
  describe('PROGRESSION_EVENT_NAMES', () => {
    it('covers the domain signals the spec lists as progression sources', () => {
      expect(PROGRESSION_EVENT_NAMES).toEqual(
        expect.arrayContaining([
          'gift.sent',
          'exp.user_leveled_up',
          'vip.upgraded',
          'family.member_joined',
          'game.settled',
          'audio_room.joined',
          'video_room.joined',
          'wallet.credited',
          'treasure.box_opened',
          'event.reward_claimed',
        ]),
      );
    });

    it('contains no duplicates — a duplicate would double-count progress', () => {
      expect(new Set(PROGRESSION_EVENT_NAMES).size).toBe(PROGRESSION_EVENT_NAMES.length);
    });
  });

  describe('resolveProgressionSubject', () => {
    it('prefers an explicit userId', () => {
      expect(resolveProgressionSubject({ userId: 'u-1', senderId: 'u-2' })).toBe('u-1');
    });

    it('credits the sender for gifting events', () => {
      expect(resolveProgressionSubject({ senderId: 'u-2' })).toBe('u-2');
    });

    it('falls back to an actorId', () => {
      expect(resolveProgressionSubject({ actorId: 'u-3' })).toBe('u-3');
    });

    it('reads a nested user object', () => {
      expect(resolveProgressionSubject({ user: { id: 'u-4' } })).toBe('u-4');
    });

    it('returns null when no subject can be determined', () => {
      expect(resolveProgressionSubject({ roomId: 'r-1' })).toBeNull();
    });

    it('returns null for a nullish payload', () => {
      expect(resolveProgressionSubject(null)).toBeNull();
      expect(resolveProgressionSubject(undefined)).toBeNull();
    });

    it('ignores non-string identifiers', () => {
      expect(resolveProgressionSubject({ userId: 42 })).toBeNull();
    });
  });
});
