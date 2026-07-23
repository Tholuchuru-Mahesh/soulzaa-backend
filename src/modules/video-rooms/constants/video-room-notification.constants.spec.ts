// src/modules/video-rooms/constants/video-room-notification.constants.spec.ts
import {
  VIDEO_ROOM_NOTIFICATION_KINDS as K,
  VIDEO_ROOM_NOTIFICATION_MATRIX as M,
  VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE,
  VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS,
  toPushPriority,
  videoRoomFanoutSentKey,
} from './video-room-notification.constants';
import { PUSH_CATEGORIES, type PushCategory } from 'src/modules/device/interfaces/push.constants';

describe('video-room notification matrix', () => {
  it('has a row for every dispatchable kind', () => {
    for (const kind of Object.values(K)) {
      expect(M[kind]).toBeDefined();
      expect(M[kind].preferenceToggle).toBeTruthy();
    }
  });

  it('never-collapse kinds (money/discrete) return undefined collapse key', () => {
    const ctx = { roomId: 'r1' };
    for (const kind of [
      K.SEAT_INVITATION,
      K.PK_WINNER,
      K.TREASURE_REWARD,
      K.SEAT_APPROVAL,
      K.MENTION,
    ]) {
      expect(M[kind].collapseKey?.(ctx)).toBeUndefined();
    }
  });

  it('collapse kinds return a room-scoped collapse key', () => {
    expect(M[K.ROOM_STARTED].collapseKey?.({ roomId: 'r1' })).toBe('vr:r1:live');
    expect(M[K.ANNOUNCEMENT].collapseKey?.({ roomId: 'r1' })).toBe('vr:r1:announcement');
  });

  it('keeps push categories coarse (INVITE/GIFT/SYSTEM only)', () => {
    const allowed = new Set<PushCategory>([
      PUSH_CATEGORIES.INVITE,
      PUSH_CATEGORIES.GIFT,
      PUSH_CATEGORIES.SYSTEM,
    ]);
    for (const kind of Object.values(K)) expect(allowed.has(M[kind].pushCategory)).toBe(true);
  });

  it('maps HIGH/CRITICAL → high push priority, else normal', () => {
    expect(toPushPriority('CRITICAL')).toBe('high');
    expect(toPushPriority('HIGH')).toBe('high');
    expect(toPushPriority('NORMAL')).toBe('normal');
    expect(toPushPriority('LOW')).toBe('normal');
  });

  it('exposes a tunable fan-out chunk size within bounds', () => {
    expect(VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE).toBeGreaterThanOrEqual(
      VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS.min,
    );
    expect(VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_SIZE).toBeLessThanOrEqual(
      VIDEO_ROOM_NOTIFICATION_FANOUT_CHUNK_BOUNDS.max,
    );
    expect(videoRoomFanoutSentKey('occ1')).toBe('video-room:notif:fanout:occ1:sent');
  });
});
