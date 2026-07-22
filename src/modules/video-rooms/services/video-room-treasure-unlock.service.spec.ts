import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { TreasureUnlockException } from '../exceptions/video-room-treasure.exceptions';
import { VideoRoomTreasureUnlockService } from './video-room-treasure-unlock.service';

const JOB = { roomId: 'r1', sessionId: 's1', boxId: 'b1', level: 1, correlationId: 'c1' };

const LEVEL_RULES = (level: number, threshold: number) => ({
  level,
  threshold,
  poolStrategy: 'PERCENTAGE',
  poolPercentBps: 1000,
  poolFixedAmount: null,
  winnerAlgorithm: 'RANDOM',
  winnerCount: 3,
  minStaySeconds: 120,
  minActivityEvents: 0,
});

const SNAPSHOT = { levelSnapshot: [LEVEL_RULES(1, 15_000), LEVEL_RULES(2, 60_000)] };

const box = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  level: 1,
  sessionId: 's1',
  roomId: 'r1',
  threshold: 15_000n,
  progress: 15_000n,
  status: TreasureBoxStatus.UNLOCKING,
  ...over,
});

describe('VideoRoomTreasureUnlockService', () => {
  let repo: Record<string, jest.Mock>;
  let rewards: Record<string, jest.Mock>;
  let eligibility: { resolve: jest.Mock };
  let winners: { select: jest.Mock };
  let distributor: { distribute: jest.Mock };
  let queue: { enqueue: jest.Mock };
  let bus: { publish: jest.Mock };
  let locks: { withLock: jest.Mock };
  let prisma: { $transaction: jest.Mock };
  let progress: Record<string, jest.Mock>;
  let metrics: Record<string, jest.Mock>;
  let service: VideoRoomTreasureUnlockService;

  const config = { get: () => ({ oversampleFactor: '3', oversampleMin: '50' }) };
  const names = () => bus.publish.mock.calls.map((c) => (c[0] as { name: string }).name);

  const pool = {
    compute: () => ({ strategy: 'PERCENTAGE', sourceAmount: 15_000n, poolAmount: 1_500n }),
    allocate: (p: bigint, ids: string[]) =>
      ids.map((userId) => ({ userId, amount: p / BigInt(ids.length || 1), shareBps: 3333 })),
  };

  beforeEach(() => {
    repo = {
      getBox: jest.fn().mockResolvedValue(box()),
      getSession: jest
        .fn()
        .mockResolvedValue({ id: 's1', status: TreasureSessionStatus.ACTIVE, currentLevel: 1 }),
      getSnapshot: jest.fn().mockResolvedValue(SNAPSHOT),
      contributionTotals: jest.fn().mockResolvedValue([]),
      listBoxes: jest.fn().mockResolvedValue([
        box(),
        box({
          id: 'b2',
          level: 2,
          threshold: 60_000n,
          progress: 0n,
          status: TreasureBoxStatus.ACTIVE,
        }),
      ]),
      openBox: jest.fn().mockResolvedValue(undefined),
      setSessionLevel: jest.fn().mockResolvedValue(undefined),
      activateBox: jest.fn().mockResolvedValue(undefined),
      transitionSession: jest.fn().mockResolvedValue({ id: 's1' }),
      claimUnlock: jest.fn().mockResolvedValue(false),
    };
    rewards = {
      createPool: jest.fn().mockResolvedValue({ id: 'p1' }),
      createWinners: jest.fn().mockResolvedValue(3),
      createPendingRewards: jest.fn().mockResolvedValue(undefined),
      markDistributed: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      setAllocated: jest.fn().mockResolvedValue(undefined),
    };
    eligibility = {
      resolve: jest.fn().mockResolvedValue({
        eligible: ['u1', 'u2', 'u3'],
        candidateCount: 12,
        activity: new Map(),
        vipTiers: new Map(),
      }),
    };
    winners = { select: jest.fn().mockReturnValue({ winners: ['u1', 'u2', 'u3'], version: 1 }) };
    distributor = {
      distribute: jest.fn().mockResolvedValue([
        { userId: 'u1', walletTxnId: 'w1' },
        { userId: 'u2', walletTxnId: 'w2' },
        { userId: 'u3', walletTxnId: 'w3' },
      ]),
    };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    locks = { withLock: jest.fn((_k: string, fn: () => unknown) => fn()) };
    prisma = { $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(prisma)) };
    progress = {
      invalidateStatus: jest.fn().mockResolvedValue(undefined),
      recordUnlockStats: jest.fn().mockResolvedValue(undefined),
    };
    metrics = { setTreasureInFlight: jest.fn(), observeTreasureWalletLatency: jest.fn() };

    service = new VideoRoomTreasureUnlockService(
      { register: jest.fn() } as never,
      locks as never,
      prisma as never,
      repo as never,
      rewards as never,
      pool as never,
      eligibility as never,
      winners as never,
      distributor as never,
      queue as never,
      bus as never,
      config as never,
      progress as never,
      metrics as never,
    );
  });

  describe('happy path', () => {
    it('pays every winner and reports the pool', async () => {
      expect(await service.handle(JOB, 1)).toEqual({
        replayed: false,
        winners: 3,
        poolAmount: 1_500,
      });
    });

    it('keys wallet idempotency on the box so a replay maps to the same txn', async () => {
      await service.handle(JOB, 1);
      expect(distributor.distribute).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyPrefix: 'vr-treasure:b1' }),
        prisma,
      );
    });

    it('publishes the pipeline events in order under one correlationId', async () => {
      await service.handle(JOB, 1);
      expect(names()).toEqual([
        'video_room.treasure.reward_generated',
        'video_room.treasure.winner_selected',
        'video_room.treasure.reward_distributed',
        'video_room.treasure.reward_distributed',
        'video_room.treasure.reward_distributed',
        'video_room.treasure.unlocked',
      ]);
      for (const call of bus.publish.mock.calls) {
        expect((call[0] as { payload: { correlationId: string } }).payload.correlationId).toBe(
          'c1',
        );
      }
    });

    it('opens the box and promotes the next level', async () => {
      await service.handle(JOB, 1);
      expect(repo.openBox).toHaveBeenCalledWith('b1', prisma);
      expect(repo.setSessionLevel).toHaveBeenCalledWith('s1', 2, prisma);
      expect(repo.activateBox).toHaveBeenCalledWith('b2', prisma);
    });

    it('records the allocated total so pool dust stays derivable', async () => {
      await service.handle(JOB, 1);
      expect(rewards.setAllocated).toHaveBeenCalledWith('b1', 1_500n, prisma);
    });

    it('serialises unlocks per room so payouts and animations stay ordered', async () => {
      await service.handle(JOB, 1);
      expect(locks.withLock).toHaveBeenCalledWith(
        'video-room:treasure:unlock:{r1}',
        expect.any(Function),
      );
    });
  });

  describe('replay safety', () => {
    it('exits as a replay when the box is already OPENED', async () => {
      repo.getBox.mockResolvedValue(box({ status: TreasureBoxStatus.OPENED }));
      expect(await service.handle(JOB, 2)).toEqual({ replayed: true, winners: 0, poolAmount: 0 });
      expect(distributor.distribute).not.toHaveBeenCalled();
    });

    // boxId @unique fired: another worker already minted this box.
    it('exits as a replay when the pool row already exists', async () => {
      rewards.createPool.mockResolvedValue(null);
      expect((await service.handle(JOB, 2)).replayed).toBe(true);
      expect(distributor.distribute).not.toHaveBeenCalled();
    });

    it('throws when the box was never claimed', async () => {
      repo.getBox.mockResolvedValue(box({ status: TreasureBoxStatus.ACTIVE }));
      await expect(service.handle(JOB, 1)).rejects.toThrow(TreasureUnlockException);
    });

    it('throws when the box does not exist', async () => {
      repo.getBox.mockResolvedValue(null);
      await expect(service.handle(JOB, 1)).rejects.toThrow(TreasureUnlockException);
    });
  });

  describe('session state', () => {
    // Winners were claimed before the pause; withholding their payout would be
    // the wrong failure mode.
    it("completes a PAUSED session's in-flight box", async () => {
      repo.getSession.mockResolvedValue({ id: 's1', status: TreasureSessionStatus.PAUSED });
      expect((await service.handle(JOB, 1)).winners).toBe(3);
    });

    it('refuses when the session was closed', async () => {
      repo.getSession.mockResolvedValue({ id: 's1', status: TreasureSessionStatus.CLOSED });
      await expect(service.handle(JOB, 1)).rejects.toThrow(TreasureUnlockException);
    });

    it('refuses when the frozen snapshot has no rules for this level', async () => {
      repo.getSnapshot.mockResolvedValue({ levelSnapshot: [LEVEL_RULES(9, 1)] });
      await expect(service.handle(JOB, 1)).rejects.toThrow(TreasureUnlockException);
    });
  });

  describe('zero eligible', () => {
    it('opens the box, mints nothing, and broadcasts empty winners', async () => {
      eligibility.resolve.mockResolvedValue({
        eligible: [],
        candidateCount: 0,
        activity: new Map(),
        vipTiers: new Map(),
      });
      winners.select.mockReturnValue({ winners: [], version: 1 });
      const res = await service.handle(JOB, 1);
      expect(res.winners).toBe(0);
      expect(distributor.distribute).not.toHaveBeenCalled();
      expect(repo.openBox).toHaveBeenCalled();
      expect(names()).toContain('video_room.treasure.unlocked');
    });
  });

  describe('chaining', () => {
    it('enqueues the next box when a combo already filled it', async () => {
      repo.listBoxes.mockResolvedValue([
        box(),
        box({
          id: 'b2',
          level: 2,
          threshold: 60_000n,
          progress: 60_000n,
          status: TreasureBoxStatus.ACTIVE,
        }),
      ]);
      repo.claimUnlock.mockResolvedValue(true);
      await service.handle(JOB, 1);
      expect(queue.enqueue).toHaveBeenCalledWith(
        'gift-processing',
        'video-room.treasure.unlock',
        expect.objectContaining({ boxId: 'b2', level: 2, correlationId: 'c1' }),
        expect.objectContaining({ jobId: 'treasure-unlock:b2' }),
      );
    });

    it('enqueues nothing when the next box is below its threshold', async () => {
      await service.handle(JOB, 1);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('enqueues nothing when another worker already claimed the next box', async () => {
      repo.listBoxes.mockResolvedValue([
        box(),
        box({ id: 'b2', level: 2, threshold: 60_000n, progress: 60_000n }),
      ]);
      repo.claimUnlock.mockResolvedValue(false);
      await service.handle(JOB, 1);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('completes the session when the final box opens', async () => {
      repo.listBoxes.mockResolvedValue([box()]);
      await service.handle(JOB, 1);
      expect(repo.transitionSession).toHaveBeenCalledWith(
        's1',
        expect.arrayContaining([TreasureSessionStatus.ACTIVE]),
        TreasureSessionStatus.COMPLETED,
        prisma,
      );
    });
  });

  describe('integration wiring', () => {
    // A payout must never be hidden behind a cached pre-unlock snapshot.
    it('invalidates the cached status view when a box opens', async () => {
      await service.handle(JOB, 1);
      expect(progress.invalidateStatus).toHaveBeenCalledWith('r1');
    });

    it('passes resolved VIP tiers into the draw', async () => {
      eligibility.resolve.mockResolvedValue({
        eligible: ['u1'],
        candidateCount: 1,
        activity: new Map(),
        vipTiers: new Map([['u1', 5]]),
      });
      await service.handle(JOB, 1);
      expect(winners.select).toHaveBeenCalledWith(
        'RANDOM',
        expect.objectContaining({ vipTiers: new Map([['u1', 5]]) }),
      );
    });

    it('measures wallet latency separately from end-to-end unlock time', async () => {
      await service.handle(JOB, 1);
      expect(metrics.observeTreasureWalletLatency).toHaveBeenCalledWith(expect.any(Number));
    });

    it('folds the unlock into the live session counters', async () => {
      await service.handle(JOB, 1);
      expect(progress.recordUnlockStats).toHaveBeenCalledWith('r1', 's1', {
        minted: 1_500,
        winners: 3,
      });
    });

    it('tracks in-flight unlocks up and back down', async () => {
      await service.handle(JOB, 1);
      expect(metrics.setTreasureInFlight).toHaveBeenNthCalledWith(1, 1);
      expect(metrics.setTreasureInFlight).toHaveBeenNthCalledWith(2, 0);
    });

    // The gauge must not leak on the failure path or it drifts upward forever.
    it('decrements the in-flight gauge even when the unlock throws', async () => {
      distributor.distribute.mockRejectedValue(new Error('boom'));
      await expect(service.handle(JOB, 1)).rejects.toThrow();
      expect(metrics.setTreasureInFlight).toHaveBeenLastCalledWith(0);
    });
  });

  describe('failure attribution', () => {
    it('records the stage, publishes the failure, and rethrows so BullMQ retries', async () => {
      distributor.distribute.mockRejectedValue(new Error('wallet timeout'));
      await expect(service.handle(JOB, 2)).rejects.toThrow('wallet timeout');
      expect(rewards.markFailed).toHaveBeenCalledWith('b1', 'DISTRIBUTION', 'wallet timeout');
      const failed = bus.publish.mock.calls.find(
        (c) => (c[0] as { name: string }).name === 'video_room.treasure.unlock_failed',
      );
      expect((failed![0] as { payload: Record<string, unknown> }).payload).toEqual(
        expect.objectContaining({ stage: 'DISTRIBUTION', attempt: 2 }),
      );
    });

    it('attributes an eligibility failure to the ELIGIBILITY stage', async () => {
      eligibility.resolve.mockRejectedValue(new Error('redis down'));
      await expect(service.handle(JOB, 1)).rejects.toThrow('redis down');
      expect(rewards.markFailed).toHaveBeenCalledWith('b1', 'ELIGIBILITY', 'redis down');
    });

    it('attributes a bad claim to the VALIDATE stage', async () => {
      repo.getBox.mockResolvedValue(box({ status: TreasureBoxStatus.PENDING }));
      await expect(service.handle(JOB, 1)).rejects.toThrow();
      expect(rewards.markFailed).toHaveBeenCalledWith('b1', 'VALIDATE', expect.any(String));
    });

    it('attributes a winner-selection failure to WINNER_SELECTION', async () => {
      winners.select.mockImplementation(() => {
        throw new Error('unknown algorithm');
      });
      await expect(service.handle(JOB, 1)).rejects.toThrow('unknown algorithm');
      expect(rewards.markFailed).toHaveBeenCalledWith(
        'b1',
        'WINNER_SELECTION',
        'unknown algorithm',
      );
    });
  });
});
