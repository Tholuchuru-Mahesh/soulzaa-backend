import { GiftCategory } from '@prisma/client';
import {
  GIFT_CATEGORY_ATTEMPTS,
  GIFT_CATEGORY_PRIORITY,
  giftComboKey,
  giftComboMember,
  giftDeliverLockKey,
  giftRecentKey,
  parseGiftComboMember,
  VIDEO_ROOM_GIFT_SOCKET_EVENTS,
} from './video-room-gift.constants';

describe('video-room gift constants', () => {
  describe('priority policy', () => {
    it('gives LUXURY and VIP_EXCLUSIVE the highest priority', () => {
      expect(GIFT_CATEGORY_PRIORITY[GiftCategory.LUXURY]).toBe(1);
      expect(GIFT_CATEGORY_PRIORITY[GiftCategory.VIP_EXCLUSIVE]).toBe(1);
    });

    it('ranks STANDARD last', () => {
      const others = [
        GiftCategory.LUXURY,
        GiftCategory.VIP_EXCLUSIVE,
        GiftCategory.PREMIUM,
        GiftCategory.EVENT,
      ].map((c) => GIFT_CATEGORY_PRIORITY[c]);
      expect(Math.max(...others)).toBeLessThan(GIFT_CATEGORY_PRIORITY[GiftCategory.STANDARD]);
    });

    it('covers every GiftCategory — a new category must not get undefined', () => {
      for (const category of Object.values(GiftCategory)) {
        expect(GIFT_CATEGORY_PRIORITY[category]).toBeGreaterThan(0);
        expect(GIFT_CATEGORY_ATTEMPTS[category]).toBeGreaterThan(0);
      }
    });
  });

  describe('redis keys', () => {
    it('namespaces every key under video-room:', () => {
      expect(giftDeliverLockKey('r1')).toBe('video-room:gift:deliver:r1');
      expect(giftComboKey('r1', 's1', 'g1')).toBe('video-room:r1:gift:combo:s1:g1');
      expect(giftRecentKey('r1')).toBe('video-room:r1:gifts:recent');
    });
  });

  describe('combo index member encoding', () => {
    it('round-trips a member', () => {
      const member = giftComboMember('r1', 's1', 'g1');
      expect(parseGiftComboMember(member)).toEqual({
        roomId: 'r1',
        senderId: 's1',
        giftId: 'g1',
      });
    });

    it('returns null for a malformed member so the sweep can skip it', () => {
      expect(parseGiftComboMember('garbage')).toBeNull();
      expect(parseGiftComboMember('a|b')).toBeNull();
      expect(parseGiftComboMember('a|b|c|d')).toBeNull();
      expect(parseGiftComboMember('a||c')).toBeNull();
    });
  });

  describe('socket events', () => {
    it('prefixes every event with video_room.', () => {
      for (const event of Object.values(VIDEO_ROOM_GIFT_SOCKET_EVENTS)) {
        expect(event.startsWith('video_room.')).toBe(true);
      }
    });

    it('exposes the nine events the phase requires', () => {
      expect(Object.keys(VIDEO_ROOM_GIFT_SOCKET_EVENTS)).toHaveLength(9);
    });
  });
});
