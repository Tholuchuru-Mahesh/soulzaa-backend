import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { VideoRoomTreasureProgressService } from './video-room-treasure-progress.service';

const box = (
  level: number,
  threshold: bigint,
  progress = 0n,
  status: TreasureBoxStatus = TreasureBoxStatus.ACTIVE,
) => ({
  id: `b${level}`,
  level,
  threshold,
  progress,
  status,
  sessionId: 's1',
  roomId: 'r1',
});

describe('VideoRoomTreasureProgressService', () => {
  let repo: Record<string, jest.Mock>;
  let cache: Record<string, jest.Mock>;
  let redis: Record<string, jest.Mock>;
  let service: VideoRoomTreasureProgressService;
  const tx = {} as never;
  const config = { get: () => ({ progressEmitPerSecond: '5' }) };

  const apply = (amount: number) =>
    service.apply(tx, { roomId: 'r1', senderId: 'u1', amount, giftTxnId: 'g1' });

  beforeEach(() => {
    repo = {
      findCurrentSession: jest.fn().mockResolvedValue({
        id: 's1',
        roomId: 'r1',
        currentLevel: 1,
        status: TreasureSessionStatus.ACTIVE,
      }),
      listBoxes: jest
        .fn()
        .mockResolvedValue([box(1, 15_000n), box(2, 60_000n, 0n, TreasureBoxStatus.PENDING)]),
      addProgress: jest.fn(),
      addContribution: jest.fn().mockResolvedValue(undefined),
      claimUnlock: jest.fn().mockResolvedValue(true),
      setSessionLevel: jest.fn().mockResolvedValue(undefined),
      activateBox: jest.fn().mockResolvedValue(undefined),
      getBox: jest.fn(),
    };
    redis = {
      hincrby: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
    };
    cache = {
      set: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      increment: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    };
    service = new VideoRoomTreasureProgressService(
      repo as never,
      cache as never,
      config as never,
      redis as never,
    );
  });

  describe('no-ops', () => {
    it('does nothing when the session is not ACTIVE', async () => {
      repo.findCurrentSession.mockResolvedValue({
        id: 's1',
        status: TreasureSessionStatus.PAUSED,
      });
      const res = await apply(5_000);
      expect(res).toEqual(expect.objectContaining({ applied: 0, claimedBoxId: null }));
      expect(repo.addProgress).not.toHaveBeenCalled();
    });

    it('does nothing when the room has no ladder', async () => {
      repo.findCurrentSession.mockResolvedValue(null);
      expect((await apply(5_000)).applied).toBe(0);
    });

    it('does nothing for a zero or negative amount', async () => {
      expect((await apply(0)).applied).toBe(0);
      expect(repo.findCurrentSession).not.toHaveBeenCalled();
    });
  });

  describe('accumulation', () => {
    it('adds progress below the threshold without claiming', async () => {
      repo.addProgress.mockResolvedValue(box(1, 15_000n, 5_000n));
      const res = await apply(5_000);
      expect(res.applied).toBe(5_000);
      expect(res.claimedBoxId).toBeNull();
      expect(repo.claimUnlock).not.toHaveBeenCalled();
    });

    it('writes an immutable contribution row for the applied amount', async () => {
      repo.addProgress.mockResolvedValue(box(1, 15_000n, 5_000n));
      await apply(5_000);
      expect(repo.addContribution).toHaveBeenCalledWith(
        expect.objectContaining({ boxId: 'b1', userId: 'u1', amount: 5_000n, giftTxnId: 'g1' }),
        tx,
      );
    });

    it('emits a progress event carrying the completion percentage', async () => {
      repo.addProgress.mockResolvedValue(box(1, 15_000n, 3_000n));
      const res = await apply(3_000);
      expect((res.events[0] as { payload: { percent: number } }).payload.percent).toBe(20);
    });
  });

  describe('the unlock claim', () => {
    it('claims the box when progress reaches the threshold', async () => {
      repo.addProgress.mockResolvedValue(box(1, 15_000n, 15_000n));
      const res = await apply(15_000);
      expect(repo.claimUnlock).toHaveBeenCalledWith('b1', tx);
      expect(res.claimedBoxId).toBe('b1');
      expect(res.claimedLevel).toBe(1);
    });

    // The loser of the claim race must not enqueue: the winner already did.
    it('reports no claim when another transaction won the race', async () => {
      repo.addProgress.mockResolvedValue(box(1, 15_000n, 15_000n));
      repo.claimUnlock.mockResolvedValue(false);
      expect((await apply(15_000)).claimedBoxId).toBeNull();
    });

    it('promotes the next box to ACTIVE and advances the session level', async () => {
      repo.addProgress.mockResolvedValue(box(1, 15_000n, 15_000n));
      await apply(15_000);
      expect(repo.setSessionLevel).toHaveBeenCalledWith('s1', 2, tx);
      expect(repo.activateBox).toHaveBeenCalledWith('b2', tx);
    });
  });

  describe('compare-and-set', () => {
    it('retries once when progress moved underneath it', async () => {
      repo.addProgress.mockResolvedValueOnce(null).mockResolvedValueOnce(box(1, 15_000n, 7_000n));
      repo.getBox.mockResolvedValue(box(1, 15_000n, 2_000n));
      const res = await apply(5_000);
      expect(repo.addProgress).toHaveBeenCalledTimes(2);
      expect(res.applied).toBe(5_000);
    });

    it('gives up after the retry budget rather than spinning', async () => {
      repo.addProgress.mockResolvedValue(null);
      repo.getBox.mockResolvedValue(box(1, 15_000n, 100n));
      const res = await apply(5_000);
      expect(repo.addProgress).toHaveBeenCalledTimes(3);
      expect(res.applied).toBe(0);
    });
  });

  describe('combo cascade', () => {
    it('spills overflow into later boxes, capped at what each still needs', async () => {
      repo.addProgress
        .mockResolvedValueOnce(box(1, 15_000n, 15_000n))
        .mockResolvedValueOnce(box(2, 60_000n, 25_000n));
      const res = await apply(40_000);
      expect(res.applied).toBe(40_000);
      expect(repo.addProgress.mock.calls[0][2]).toBe(15_000n); // capped at L1's need
      expect(repo.addProgress.mock.calls[1][2]).toBe(25_000n); // remainder to L2
    });

    // Only the LOWEST crossed box is enqueued; the unlock handler chains the
    // rest, which is what keeps payouts and animations in level order.
    it('reports only the lowest crossed level for enqueue', async () => {
      repo.addProgress
        .mockResolvedValueOnce(box(1, 15_000n, 15_000n))
        .mockResolvedValueOnce(box(2, 60_000n, 60_000n));
      const res = await apply(75_000);
      expect(res.claimedLevel).toBe(1);
      expect(res.claimedBoxId).toBe('b1');
      expect(repo.claimUnlock).toHaveBeenCalledTimes(2); // both boxes claimed
    });

    it('stops counting once the ladder is exhausted, refunding nothing', async () => {
      repo.listBoxes.mockResolvedValue([box(1, 15_000n)]);
      repo.addProgress.mockResolvedValue(box(1, 15_000n, 15_000n));
      const res = await apply(999_000);
      expect(res.applied).toBe(15_000);
    });

    it('skips a box that is already UNLOCKING and spills into the next', async () => {
      repo.listBoxes.mockResolvedValue([
        box(1, 15_000n, 15_000n, TreasureBoxStatus.UNLOCKING),
        box(2, 60_000n),
      ]);
      repo.addProgress.mockResolvedValue(box(2, 60_000n, 5_000n));
      const res = await apply(5_000);
      expect(repo.addProgress.mock.calls[0][0]).toBe('b2');
      expect(res.applied).toBe(5_000);
    });
  });

  describe('activity counter', () => {
    // Write and read MUST agree on key AND type. An earlier revision wrote a
    // per-user STRING while eligibility read a HASH field, so every count read
    // as 0 — silently degrading ACTIVITY_BASED to a uniform draw and making any
    // minActivityEvents > 0 exclude the entire room.
    it('increments a HASH field keyed by userId, matching the eligibility read', async () => {
      await service.recordActivity('r1', 's1', 'u1');
      expect(redis.hincrby).toHaveBeenCalledWith('video-room:treasure:activity:r1:s1', 'u1', 1);
    });

    it('refreshes the TTL so the hash cannot leak once a room goes quiet', async () => {
      await service.recordActivity('r1', 's1', 'u1');
      expect(redis.expire).toHaveBeenCalledWith(
        'video-room:treasure:activity:r1:s1',
        expect.any(Number),
      );
    });

    it('never writes a per-user string key', async () => {
      await service.recordActivity('r1', 's1', 'u1');
      const key = redis.hincrby.mock.calls[0][0] as string;
      expect(key.endsWith(':u1')).toBe(false);
    });
  });

  describe('status cache', () => {
    // The ladder just moved, so any cached snapshot is stale by definition.
    it('invalidates the cached status view whenever progress is mirrored', async () => {
      await service.mirror('r1', 1, 5_000);
      expect(cache.del).toHaveBeenCalledWith('video-room:treasure:status:r1');
    });

    it('writes the mirror under a short TTL and drops it on demand', async () => {
      await service.writeStatusCache('r1', { active: true });
      expect(cache.set).toHaveBeenCalledWith(
        'video-room:treasure:status:r1',
        { active: true },
        expect.any(Number),
      );
      await service.invalidateStatus('r1');
      expect(cache.del).toHaveBeenCalledWith('video-room:treasure:status:r1');
    });
  });

  describe('shouldEmit throttle', () => {
    it('allows the first emit in a window', async () => {
      cache.get.mockResolvedValue(null);
      expect(await service.shouldEmit('r1')).toBe(true);
      expect(cache.set).toHaveBeenCalled();
    });

    it('suppresses a second emit inside the window', async () => {
      cache.get.mockResolvedValue(Date.now());
      expect(await service.shouldEmit('r1')).toBe(false);
    });

    it('allows an emit once the window has passed', async () => {
      cache.get.mockResolvedValue(Date.now() - 10_000);
      expect(await service.shouldEmit('r1')).toBe(true);
    });

    it('disables throttling entirely at 0 per second', async () => {
      service = new VideoRoomTreasureProgressService(
        repo as never,
        cache as never,
        { get: () => ({ progressEmitPerSecond: '0' }) } as never,
        redis as never,
      );
      expect(await service.shouldEmit('r1')).toBe(true);
      expect(cache.get).not.toHaveBeenCalled();
    });
  });
});
