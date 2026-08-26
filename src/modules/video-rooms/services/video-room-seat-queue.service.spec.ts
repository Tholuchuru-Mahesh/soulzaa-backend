import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { videoRoomSeatLockKey, videoRoomSeatQueueLockKey } from '../constants/video-room.constants';
import { VideoRoomSeatQueueService } from './video-room-seat-queue.service';

const QKEY = 'video-room:seatq:{r1}';
const SKEY = 'video-room:seatq:{r1}:skips';

describe('VideoRoomSeatQueueService', () => {
  let deps: any;
  let svc: VideoRoomSeatQueueService;

  beforeEach(() => {
    deps = {
      cache: {
        exists: jest.fn().mockResolvedValue(true),
        setScore: jest.fn(),
        sortedRank: jest.fn().mockResolvedValue(null),
        sortedLowest: jest.fn().mockResolvedValue([]),
        sortedRemove: jest.fn().mockResolvedValue(1),
        sortedCount: jest.fn().mockResolvedValue(0),
        score: jest.fn().mockResolvedValue(null),
        addScore: jest.fn().mockResolvedValue(1),
        expire: jest.fn(),
        del: jest.fn().mockResolvedValue(1),
      },
      seats: { listPendingRequests: jest.fn().mockResolvedValue([]) },
      vip: { getEffectiveLevel: jest.fn().mockResolvedValue(0) },
      bus: { publish: jest.fn() },
      seatSvc: {
        seatUser: jest.fn().mockResolvedValue({ version: 7 }),
        requireLiveRoom: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'owner' }),
        assertActiveMember: jest.fn(),
      },
      locks: { withLock: jest.fn(async (_k: string, fn: () => Promise<unknown>) => fn()) },
      events: { appendEvent: jest.fn() },
    };
    svc = new VideoRoomSeatQueueService(
      deps.cache,
      deps.seats,
      deps.vip,
      deps.bus,
      deps.seatSvc,
      deps.locks,
      deps.events,
    );
  });

  describe('enqueue', () => {
    it('writes a score into the room queue and returns a 1-based position', async () => {
      deps.cache.sortedRank.mockResolvedValue(0);
      const pos = await svc.enqueue('r1', 'u1', new Date('2026-07-21T10:00:00Z'));
      expect(deps.cache.setScore).toHaveBeenCalledWith(QKEY, 'u1', expect.any(Number));
      expect(pos).toBe(1);
    });

    it('scores a VIP ahead of a non-VIP who arrived earlier', async () => {
      deps.vip.getEffectiveLevel.mockResolvedValue(5);
      await svc.enqueue('r1', 'vip', new Date('2026-07-21T10:05:00Z'));
      const vipScore = deps.cache.setScore.mock.calls[0][2];

      deps.vip.getEffectiveLevel.mockResolvedValue(0);
      await svc.enqueue('r1', 'free', new Date('2026-07-21T10:00:00Z'));
      const freeScore = deps.cache.setScore.mock.calls[1][2];

      expect(vipScore).toBeLessThan(freeScore);
    });

    it('refreshes the projection TTL on write', async () => {
      await svc.enqueue('r1', 'u1', new Date());
      expect(deps.cache.expire).toHaveBeenCalledWith(QKEY, expect.any(Number));
    });

    it('publishes a queue update', async () => {
      await svc.enqueue('r1', 'u1', new Date());
      expect(deps.bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'video_room.seat_queue_updated' }),
      );
    });

    it('rebuilds from Postgres when the projection is missing before writing', async () => {
      deps.cache.exists.mockResolvedValue(false);
      deps.seats.listPendingRequests.mockResolvedValue([
        { userId: 'existing', createdAt: new Date('2026-07-21T09:00:00Z') },
      ]);
      await svc.enqueue('r1', 'u1', new Date('2026-07-21T10:00:00Z'));
      expect(deps.seats.listPendingRequests).toHaveBeenCalledWith('r1');
    });

    it('does not reject when a subscriber throws while publishing the update', async () => {
      deps.bus.publish.mockRejectedValue(new Error('subscriber exploded'));
      deps.cache.sortedRank.mockResolvedValue(0);
      await expect(svc.enqueue('r1', 'u1', new Date())).resolves.toBe(1);
    });

    it('rebuilds exactly once on a cache miss, not once per internal ensureProjection call', async () => {
      deps.cache.exists.mockResolvedValue(false);
      deps.seats.listPendingRequests.mockResolvedValue([
        { userId: 'existing', createdAt: new Date('2026-07-21T09:00:00Z') },
      ]);
      await svc.enqueue('r1', 'u1', new Date('2026-07-21T10:00:00Z'));
      expect(deps.seats.listPendingRequests).toHaveBeenCalledTimes(1);
    });
  });

  describe('dequeue', () => {
    it('removes the member from both the queue and the skip ledger', async () => {
      await svc.dequeue('r1', 'u1');
      expect(deps.cache.sortedRemove).toHaveBeenCalledWith(QKEY, 'u1');
      expect(deps.cache.sortedRemove).toHaveBeenCalledWith(SKEY, 'u1');
    });

    it('publishes a queue update', async () => {
      await svc.dequeue('r1', 'u1');
      expect(deps.bus.publish).toHaveBeenCalled();
    });

    it('refreshes the projection TTL after removing', async () => {
      await svc.dequeue('r1', 'u1');
      expect(deps.cache.expire).toHaveBeenCalledWith(QKEY, expect.any(Number));
    });

    it('rebuilds from Postgres when the projection is missing before removing', async () => {
      deps.cache.exists.mockResolvedValue(false);
      deps.seats.listPendingRequests.mockResolvedValue([
        { userId: 'u1', createdAt: new Date('2026-07-21T09:00:00Z') },
      ]);
      await svc.dequeue('r1', 'u1');
      expect(deps.seats.listPendingRequests).toHaveBeenCalledWith('r1');
    });

    it('does not reject when a subscriber throws while publishing the update', async () => {
      deps.bus.publish.mockRejectedValue(new Error('subscriber exploded'));
      await expect(svc.dequeue('r1', 'u1')).resolves.toBeUndefined();
    });

    it('rebuilds exactly once on a cache miss, not once per internal ensureProjection call', async () => {
      deps.cache.exists.mockResolvedValue(false);
      deps.seats.listPendingRequests.mockResolvedValue([
        { userId: 'u1', createdAt: new Date('2026-07-21T09:00:00Z') },
      ]);
      await svc.dequeue('r1', 'u1');
      expect(deps.seats.listPendingRequests).toHaveBeenCalledTimes(1);
    });
  });

  describe('position', () => {
    it('converts the 0-based Redis rank to a 1-based position', async () => {
      deps.cache.sortedRank.mockResolvedValue(2);
      await expect(svc.position('r1', 'u1')).resolves.toBe(3);
    });

    it('returns null when the user is not queued', async () => {
      deps.cache.sortedRank.mockResolvedValue(null);
      await expect(svc.position('r1', 'u1')).resolves.toBeNull();
    });

    it('rebuilds from Postgres when the projection is missing, then answers', async () => {
      deps.cache.exists.mockResolvedValue(false);
      deps.seats.listPendingRequests.mockResolvedValue([
        { userId: 'u1', createdAt: new Date('2026-07-21T10:00:00Z') },
      ]);
      deps.cache.sortedRank.mockResolvedValue(0);
      await expect(svc.position('r1', 'u1')).resolves.toBe(1);
      expect(deps.seats.listPendingRequests).toHaveBeenCalledWith('r1');
      expect(deps.cache.setScore).toHaveBeenCalledWith(QKEY, 'u1', expect.any(Number));
    });
  });

  describe('list', () => {
    it('returns ordered entries with 1-based positions', async () => {
      deps.cache.sortedLowest.mockResolvedValue([
        { member: 'u1', score: 10 },
        { member: 'u2', score: 20 },
      ]);
      deps.vip.getEffectiveLevel.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
      const rows = await svc.list('r1');
      expect(rows).toEqual([
        { userId: 'u1', position: 1, vipLevel: 3, score: 10 },
        { userId: 'u2', position: 2, vipLevel: 0, score: 20 },
      ]);
    });

    it('honours an explicit limit', async () => {
      await svc.list('r1', 5);
      expect(deps.cache.sortedLowest).toHaveBeenCalledWith(QKEY, 5);
    });
  });

  describe('rebuild', () => {
    it('replays every PENDING row and returns the count', async () => {
      deps.seats.listPendingRequests.mockResolvedValue([
        { userId: 'u1', createdAt: new Date('2026-07-21T10:00:00Z') },
        { userId: 'u2', createdAt: new Date('2026-07-21T10:01:00Z') },
      ]);
      await expect(svc.rebuild('r1')).resolves.toBe(2);
      expect(deps.cache.setScore).toHaveBeenCalledTimes(2);
    });

    it('is a no-op that still succeeds when there is nothing pending', async () => {
      deps.seats.listPendingRequests.mockResolvedValue([]);
      await expect(svc.rebuild('r1')).resolves.toBe(0);
      expect(deps.cache.setScore).not.toHaveBeenCalled();
    });
  });

  describe('assertQueueAccess', () => {
    it('requires the room to be live and the caller to be an active member', async () => {
      await svc.assertQueueAccess('r1', 'u1');
      expect(deps.seatSvc.requireLiveRoom).toHaveBeenCalledWith('r1');
      expect(deps.seatSvc.assertActiveMember).toHaveBeenCalledWith('r1', 'u1');
    });

    it('propagates a not-live-room rejection without checking membership', async () => {
      const err = new Error('not live');
      deps.seatSvc.requireLiveRoom.mockRejectedValue(err);
      await expect(svc.assertQueueAccess('r1', 'u1')).rejects.toBe(err);
      expect(deps.seatSvc.assertActiveMember).not.toHaveBeenCalled();
    });

    it('propagates a not-an-active-member rejection', async () => {
      const err = new Error('not a member');
      deps.seatSvc.assertActiveMember.mockRejectedValue(err);
      await expect(svc.assertQueueAccess('r1', 'u1')).rejects.toBe(err);
    });
  });

  describe('clear', () => {
    it('drops both projection keys', async () => {
      await svc.clear('r1');
      expect(deps.cache.del).toHaveBeenCalledWith(QKEY, SKEY);
    });
  });

  describe('publishUpdate', () => {
    it('caps the broadcast preview rather than sending the whole queue', async () => {
      const many = Array.from({ length: 50 }, (_, i) => ({ member: `u${i}`, score: i }));
      deps.cache.sortedLowest.mockResolvedValue(many);
      deps.cache.sortedCount.mockResolvedValue(50);
      await svc.publishUpdate('r1');
      const event = deps.bus.publish.mock.calls[0][0]; // a SeatQueueUpdatedEvent
      expect(event.payload.size).toBe(50);
      expect(event.payload.top.length).toBeLessThanOrEqual(20);
    });

    it('rebuilds from Postgres instead of broadcasting an empty queue when the projection is missing', async () => {
      deps.cache.exists.mockResolvedValue(false);
      deps.seats.listPendingRequests.mockResolvedValue([
        { userId: 'u1', createdAt: new Date('2026-07-21T09:00:00Z') },
      ]);
      deps.cache.sortedCount.mockResolvedValue(1);
      deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
      await svc.publishUpdate('r1');
      expect(deps.seats.listPendingRequests).toHaveBeenCalledWith('r1');
      const event = deps.bus.publish.mock.calls[0][0];
      expect(event.payload.size).toBe(1);
    });

    it('does not reject when called directly and a subscriber throws', async () => {
      deps.bus.publish.mockRejectedValue(new Error('subscriber exploded'));
      await expect(svc.publishUpdate('r1')).resolves.toBeUndefined();
    });
  });

  describe('advance', () => {
    const CREATED_AT = new Date('2026-07-21T10:00:00Z');

    beforeEach(() => {
      deps.seatSvc = { seatUser: jest.fn().mockResolvedValue({ version: 7 }) };
      deps.locks = { withLock: jest.fn(async (_k: string, fn: () => Promise<unknown>) => fn()) };
      deps.seats.findPendingRequest = jest
        .fn()
        .mockResolvedValue({ id: 'q1', userId: 'u1', createdAt: CREATED_AT });
      deps.seats.setRequestStatus = jest.fn();
      deps.events = { appendEvent: jest.fn() };
      svc = new VideoRoomSeatQueueService(
        deps.cache,
        deps.seats,
        deps.vip,
        deps.bus,
        deps.seatSvc,
        deps.locks,
        deps.events,
      );
    });

    it('seats the front of the queue and returns their id', async () => {
      deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
      await expect(svc.advance('r1', 3, 'system')).resolves.toBe('u1');
      expect(deps.seatSvc.seatUser).toHaveBeenCalledWith('r1', 'u1', 'system', 3, undefined);
    });

    it('advances under the dedicated queue lock, NOT the re-entrant-unsafe seat lock', async () => {
      deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
      await svc.advance('r1', 3, 'system');
      expect(deps.locks.withLock).toHaveBeenCalledWith(
        videoRoomSeatQueueLockKey('r1'),
        expect.any(Function),
      );
      // Regression guard: reusing the seat lock here deadlocks against
      // seatUser -> mutateStage, which acquires it with SET NX.
      expect(deps.locks.withLock).not.toHaveBeenCalledWith(
        videoRoomSeatLockKey('r1'),
        expect.any(Function),
      );
    });

    it('never re-enters the seat lock even when seatUser itself takes it internally', async () => {
      // Catches the whole re-entrancy CLASS, not one hardcoded key string: the
      // withLock mock throws if a key is acquired while already held, and
      // seatUser's mock mirrors the real seatUser -> mutateStage path by
      // taking the seat lock itself. If `advance` ever switched to acquiring
      // the seat lock (instead of the dedicated queue lock) before calling
      // seatUser, this test would deadlock-detect it with no Redis involved.
      const held = new Set<string>();
      deps.locks.withLock = jest.fn(async (k: string, fn: () => Promise<unknown>) => {
        if (held.has(k)) throw new Error(`re-entrant lock acquisition on ${k}`);
        held.add(k);
        try {
          return await fn();
        } finally {
          held.delete(k);
        }
      });
      deps.seatSvc.seatUser = jest.fn(async () => {
        return deps.locks.withLock(videoRoomSeatLockKey('r1'), async () => ({ version: 7 }));
      });
      deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);

      await expect(svc.advance('r1', 3, 'system')).resolves.toBe('u1');
    });

    it('marks the seated user PROMOTED and removes them from the queue and skip ledger', async () => {
      deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
      await svc.advance('r1', 3, 'system');
      expect(deps.seats.setRequestStatus).toHaveBeenCalledWith(
        'q1',
        'PROMOTED',
        'system',
        'system',
        expect.objectContaining({ bumpAttempt: true }),
      );
      expect(deps.cache.sortedRemove).toHaveBeenCalledWith(QKEY, 'u1');
      expect(deps.cache.sortedRemove).toHaveBeenCalledWith(SKEY, 'u1');
    });

    it('returns null and seats nobody when the queue is empty', async () => {
      deps.cache.sortedLowest.mockResolvedValue([]);
      await expect(svc.advance('r1', 3, 'system')).resolves.toBeNull();
      expect(deps.seatSvc.seatUser).not.toHaveBeenCalled();
    });

    it('skips a candidate whose seating throws and tries the next one', async () => {
      deps.cache.sortedLowest.mockResolvedValue([
        { member: 'u1', score: 10 },
        { member: 'u2', score: 20 },
      ]);
      deps.seats.findPendingRequest = jest
        .fn()
        .mockResolvedValueOnce({
          id: 'q1',
          userId: 'u1',
          createdAt: new Date('2026-07-21T10:00:00Z'),
        })
        .mockResolvedValueOnce({
          id: 'q2',
          userId: 'u2',
          createdAt: new Date('2026-07-21T10:00:00Z'),
        });
      deps.seatSvc.seatUser
        .mockRejectedValueOnce(new BusinessException(ERROR_CODES.SEAT_TAKEN, 'seat taken'))
        .mockResolvedValueOnce({ version: 8 });

      await expect(svc.advance('r1', 3, 'system')).resolves.toBe('u2');
      expect(deps.cache.addScore).toHaveBeenCalledWith(SKEY, 'u1', 1);
    });

    it('propagates a non-BusinessException error instead of charging it to the candidate as a skip', async () => {
      // A Redis/Postgres outage or lock-timeout must not be treated as "this
      // candidate can't be seated" — that would burn every candidate's skip
      // counter and permanently distort fairness ordering long after the
      // outage clears.
      deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
      deps.seats.findPendingRequest = jest.fn().mockResolvedValue({
        id: 'q1',
        userId: 'u1',
        createdAt: new Date('2026-07-21T10:00:00Z'),
      });
      const infraError = new Error('ECONNREFUSED');
      deps.seatSvc.seatUser.mockRejectedValue(infraError);

      await expect(svc.advance('r1', 3, 'system')).rejects.toBe(infraError);
      expect(deps.cache.addScore).not.toHaveBeenCalled();
    });

    it('skips a candidate who no longer holds a pending request', async () => {
      deps.cache.sortedLowest.mockResolvedValue([
        { member: 'ghost', score: 10 },
        { member: 'u2', score: 20 },
      ]);
      deps.seats.findPendingRequest = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'q2', userId: 'u2', createdAt: CREATED_AT });

      await expect(svc.advance('r1', 3, 'system')).resolves.toBe('u2');
      expect(deps.cache.sortedRemove).toHaveBeenCalledWith(QKEY, 'ghost');
    });

    it('makes exactly one pass — it does not retry a candidate it already skipped', async () => {
      deps.cache.sortedLowest.mockResolvedValue([
        { member: 'u1', score: 10 },
        { member: 'u2', score: 20 },
      ]);
      deps.seats.findPendingRequest = jest.fn().mockResolvedValue({
        id: 'q',
        userId: 'x',
        createdAt: new Date('2026-07-21T10:00:00Z'),
      });
      deps.seatSvc.seatUser.mockRejectedValue(
        new BusinessException(ERROR_CODES.SEAT_TAKEN, 'always fails'),
      );

      await expect(svc.advance('r1', 3, 'system')).resolves.toBeNull();
      expect(deps.seatSvc.seatUser).toHaveBeenCalledTimes(2);
    });

    it('publishes a queue update after a successful advance', async () => {
      deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
      deps.bus.publish.mockClear();
      await svc.advance('r1', 3, 'system');
      expect(deps.bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'video_room.seat_queue_updated' }),
      );
    });

    it('broadcasts via the private path and does not re-run the projection guard', async () => {
      // Pin that `advance` uses the internal broadcastUpdate/ensureProjection
      // pairing rather than the public rebuild-checking path: with the
      // projection missing, one `advance` call must hit Postgres exactly
      // once, not once per internal call site.
      deps.cache.exists.mockResolvedValue(false);
      deps.seats.listPendingRequests.mockResolvedValue([
        { userId: 'u1', createdAt: new Date('2026-07-21T09:00:00Z') },
      ]);
      deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);

      await svc.advance('r1', 3, 'system');

      expect(deps.seats.listPendingRequests).toHaveBeenCalledTimes(1);
    });

    it('appends a seat.queue_advanced audit event on a successful advance', async () => {
      deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
      await svc.advance('r1', 3, 'system');
      expect(deps.events.appendEvent).toHaveBeenCalledWith({
        roomId: 'r1',
        actorId: 'system',
        eventType: 'seat.queue_advanced',
        payload: { requestId: 'q1', userId: 'u1', seatIndex: 3 },
      });
    });

    it('publishes SeatRequestResolvedEvent(PROMOTED) on a successful advance — the manual path’s counterpart', async () => {
      // Without this, an auto-promoted viewer's client never learns their
      // request resolved (the "waiting for approval" UI never clears), and
      // every promotion metric derived from REQUEST_RESOLVED undercounts
      // auto-advance rooms.
      deps.cache.sortedLowest.mockResolvedValue([{ member: 'u1', score: 10 }]);
      deps.bus.publish.mockClear();
      await svc.advance('r1', 3, 'system');
      expect(deps.bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'video_room.seat_request_resolved',
          payload: expect.objectContaining({
            roomId: 'r1',
            requestId: 'q1',
            userId: 'u1',
            status: 'PROMOTED',
            actorId: 'system',
            version: 7,
            seatIndex: 3,
            requestedAt: CREATED_AT.toISOString(),
          }),
        }),
      );
    });

    it('does not append an audit event or publish a resolution when nobody could be seated', async () => {
      deps.cache.sortedLowest.mockResolvedValue([]);
      await svc.advance('r1', 3, 'system');
      expect(deps.events.appendEvent).not.toHaveBeenCalled();
      const names = deps.bus.publish.mock.calls.map((c: any[]) => c[0].name);
      expect(names).not.toContain('video_room.seat_request_resolved');
    });
  });
});
