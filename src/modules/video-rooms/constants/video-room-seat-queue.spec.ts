import {
  QUEUE_FAIRNESS_SKIP_CAP,
  computeQueueScore,
  videoRoomSeatQueueKey,
  videoRoomSeatQueueSkipsKey,
} from './video-room-seat-queue';

const at = (iso: string) => new Date(iso);

describe('computeQueueScore', () => {
  it('orders earlier requests first when VIP level and skips are equal', () => {
    const early = computeQueueScore({
      vipLevel: 0,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: 0,
    });
    const late = computeQueueScore({
      vipLevel: 0,
      createdAt: at('2026-07-21T10:05:00Z'),
      skipCount: 0,
    });
    expect(early).toBeLessThan(late);
  });

  it('orders a higher VIP level ahead of an earlier non-VIP request', () => {
    const vip = computeQueueScore({
      vipLevel: 3,
      createdAt: at('2026-07-21T10:05:00Z'),
      skipCount: 0,
    });
    const free = computeQueueScore({
      vipLevel: 0,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: 0,
    });
    expect(vip).toBeLessThan(free);
  });

  it('orders a higher VIP level ahead of a lower VIP level', () => {
    const titan = computeQueueScore({
      vipLevel: 7,
      createdAt: at('2026-07-21T10:09:00Z'),
      skipCount: 0,
    });
    const bronze = computeQueueScore({
      vipLevel: 1,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: 0,
    });
    expect(titan).toBeLessThan(bronze);
  });

  it('breaks VIP ties on arrival time', () => {
    const first = computeQueueScore({
      vipLevel: 2,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: 0,
    });
    const second = computeQueueScore({
      vipLevel: 2,
      createdAt: at('2026-07-21T10:00:01Z'),
      skipCount: 0,
    });
    expect(first).toBeLessThan(second);
  });

  it('pins an entry at the fairness cap ahead of the highest VIP', () => {
    const starved = computeQueueScore({
      vipLevel: 0,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: QUEUE_FAIRNESS_SKIP_CAP,
    });
    const titan = computeQueueScore({
      vipLevel: 7,
      createdAt: at('2026-07-21T09:00:00Z'),
      skipCount: 0,
    });
    expect(starved).toBeLessThan(titan);
  });

  it('does not pin an entry one skip below the cap', () => {
    const nearlyStarved = computeQueueScore({
      vipLevel: 0,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: QUEUE_FAIRNESS_SKIP_CAP - 1,
    });
    const titan = computeQueueScore({
      vipLevel: 7,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: 0,
    });
    expect(titan).toBeLessThan(nearlyStarved);
  });

  it('orders two pinned entries among themselves by arrival time', () => {
    const older = computeQueueScore({
      vipLevel: 0,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: QUEUE_FAIRNESS_SKIP_CAP,
    });
    const newer = computeQueueScore({
      vipLevel: 0,
      createdAt: at('2026-07-21T10:01:00Z'),
      skipCount: QUEUE_FAIRNESS_SKIP_CAP + 5,
    });
    expect(older).toBeLessThan(newer);
  });

  it('is pure — the same input always yields the same score', () => {
    const input = { vipLevel: 4, createdAt: at('2026-07-21T10:00:00Z'), skipCount: 1 };
    expect(computeQueueScore(input)).toBe(computeQueueScore(input));
  });

  it('produces a finite, safe-integer-range score', () => {
    const score = computeQueueScore({
      vipLevel: 0,
      createdAt: at('2099-12-31T23:59:59Z'),
      skipCount: 0,
    });
    expect(Number.isFinite(score)).toBe(true);
    expect(Math.abs(score)).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('treats a non-finite vipLevel (NaN) as vipLevel: 0', () => {
    const withNaN = computeQueueScore({
      vipLevel: NaN,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: 0,
    });
    const withZero = computeQueueScore({
      vipLevel: 0,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: 0,
    });
    expect(withNaN).toBe(withZero);
  });

  it('yields a finite score when createdAt is an Invalid Date', () => {
    const score = computeQueueScore({
      vipLevel: 0,
      createdAt: new Date('nope'),
      skipCount: 0,
    });
    expect(Number.isFinite(score)).toBe(true);
  });

  it('floors fractional vipLevel (3.5 → 3)', () => {
    const fractional = computeQueueScore({
      vipLevel: 3.5,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: 0,
    });
    const floored = computeQueueScore({
      vipLevel: 3,
      createdAt: at('2026-07-21T10:00:00Z'),
      skipCount: 0,
    });
    expect(fractional).toBe(floored);
  });
});

describe('queue keys', () => {
  it('namespaces the queue and skip keys per room', () => {
    expect(videoRoomSeatQueueKey('room-1')).toBe('video-room:seatq:{room-1}');
    expect(videoRoomSeatQueueSkipsKey('room-1')).toBe('video-room:seatq:{room-1}:skips');
  });
});
