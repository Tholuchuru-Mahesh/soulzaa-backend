import { VideoRoomRankingRepository } from './video-room-ranking.repository';

const KEY = { scope: 'g', dimension: 'hosts', period: 'daily', dateKey: '20260722' };
const WINDOW = { start: new Date('2026-07-22T00:00:00Z'), end: new Date('2026-07-23T00:00:00Z') };

describe('VideoRoomRankingRepository', () => {
  let prisma: any;
  let repo: VideoRoomRankingRepository;

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', country: 'IN' }]) },
      userProfile: { findMany: jest.fn().mockResolvedValue([{ userId: 'u1', city: 'c9' }]) },
      userStatistics: { findMany: jest.fn().mockResolvedValue([]) },
      videoRoom: { findMany: jest.fn().mockResolvedValue([]) },
      videoRoomRankingSnapshot: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
      videoRoomLeaderboardSnapshot: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      videoRoomRankingAggregationLog: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      giftTransaction: { groupBy: jest.fn().mockResolvedValue([]) },
      videoRoomPkBattle: { findMany: jest.fn().mockResolvedValue([]) },
      videoRoomPkParticipant: { findMany: jest.fn().mockResolvedValue([]) },
      videoRoomPkContribution: { groupBy: jest.fn().mockResolvedValue([]) },
      treasureWinner: { groupBy: jest.fn().mockResolvedValue([]) },
      videoRoomStatistics: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    repo = new VideoRoomRankingRepository(prisma);
  });

  describe('findUserGeo', () => {
    it('joins country from user and city from profile', async () => {
      await expect(repo.findUserGeo(['u1'])).resolves.toEqual([
        { userId: 'u1', country: 'IN', city: 'c9' },
      ]);
    });

    it('returns null city when the user has no profile row', async () => {
      prisma.userProfile.findMany.mockResolvedValue([]);
      await expect(repo.findUserGeo(['u1'])).resolves.toEqual([
        { userId: 'u1', country: 'IN', city: null },
      ]);
    });

    it('short-circuits on an empty id list', async () => {
      await expect(repo.findUserGeo([])).resolves.toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('saveRankingSnapshots', () => {
    it('skips duplicates so a replayed snapshot is a no-op', async () => {
      await expect(repo.saveRankingSnapshots([{ scope: 'g' } as never])).resolves.toBe(2);
      expect(prisma.videoRoomRankingSnapshot.createMany).toHaveBeenCalledWith({
        data: [{ scope: 'g' }],
        skipDuplicates: true,
      });
    });

    it('writes nothing for an empty batch', async () => {
      await expect(repo.saveRankingSnapshots([])).resolves.toBe(0);
      expect(prisma.videoRoomRankingSnapshot.createMany).not.toHaveBeenCalled();
    });
  });

  describe('beginAggregation', () => {
    it('claims the window when no log row exists', async () => {
      await expect(repo.beginAggregation(KEY, WINDOW.start, WINDOW.end)).resolves.toBe('CLAIMED');
      expect(prisma.videoRoomRankingAggregationLog.upsert).toHaveBeenCalled();
    });

    it('creates a RUNNING row keyed by the ladder key when none exists yet', async () => {
      await repo.beginAggregation(KEY, WINDOW.start, WINDOW.end);
      const call = prisma.videoRoomRankingAggregationLog.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ scope_dimension_period_dateKey: { ...KEY } });
      expect(call.create).toEqual({
        ...KEY,
        status: 'RUNNING',
        windowStart: WINDOW.start,
        windowEnd: WINDOW.end,
      });
    });

    it('refuses to re-run a window that already succeeded', async () => {
      prisma.videoRoomRankingAggregationLog.findUnique.mockResolvedValue({ status: 'SUCCEEDED' });
      await expect(repo.beginAggregation(KEY, WINDOW.start, WINDOW.end)).resolves.toBe(
        'ALREADY_SUCCEEDED',
      );
      expect(prisma.videoRoomRankingAggregationLog.upsert).not.toHaveBeenCalled();
    });

    it('re-claims a window whose previous run FAILED, resetting finishedAt and error', async () => {
      prisma.videoRoomRankingAggregationLog.findUnique.mockResolvedValue({
        status: 'FAILED',
        error: 'boom',
        finishedAt: new Date('2026-07-22T01:00:00Z'),
      });
      await expect(repo.beginAggregation(KEY, WINDOW.start, WINDOW.end)).resolves.toBe('CLAIMED');
      const call = prisma.videoRoomRankingAggregationLog.upsert.mock.calls[0][0];
      expect(call.update).toEqual(
        expect.objectContaining({
          status: 'RUNNING',
          windowStart: WINDOW.start,
          windowEnd: WINDOW.end,
          finishedAt: null,
          error: null,
        }),
      );
      expect(call.update.startedAt).toBeInstanceOf(Date);
    });

    it('re-claims a window left RUNNING by a crashed worker, resetting finishedAt and error', async () => {
      prisma.videoRoomRankingAggregationLog.findUnique.mockResolvedValue({
        status: 'RUNNING',
        error: null,
        finishedAt: null,
      });
      await expect(repo.beginAggregation(KEY, WINDOW.start, WINDOW.end)).resolves.toBe('CLAIMED');
      const call = prisma.videoRoomRankingAggregationLog.upsert.mock.calls[0][0];
      expect(call.update).toEqual(
        expect.objectContaining({
          status: 'RUNNING',
          windowStart: WINDOW.start,
          windowEnd: WINDOW.end,
          finishedAt: null,
          error: null,
        }),
      );
    });
  });

  describe('invalidateAggregation', () => {
    it('uses updateMany, not update, so a missing row resolves instead of throwing', async () => {
      await expect(repo.invalidateAggregation(KEY, 'invalidated by operator replay')).resolves.toBe(
        0,
      );
      expect(prisma.videoRoomRankingAggregationLog.updateMany).toHaveBeenCalled();
      expect(prisma.videoRoomRankingAggregationLog.update).not.toHaveBeenCalled();
    });

    it('filters on all four key fields (scope, dimension, period, dateKey)', async () => {
      await repo.invalidateAggregation(KEY, 'invalidated by operator replay');
      const call = prisma.videoRoomRankingAggregationLog.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ ...KEY });
    });

    it('sets status FAILED, writes the reason into error, and stamps finishedAt', async () => {
      await repo.invalidateAggregation(KEY, 'invalidated by operator replay');
      const call = prisma.videoRoomRankingAggregationLog.updateMany.mock.calls[0][0];
      expect(call.data.status).toBe('FAILED');
      expect(call.data.error).toBe('invalidated by operator replay');
      expect(call.data.finishedAt).toBeInstanceOf(Date);
    });

    it('returns the affected count reported by updateMany', async () => {
      prisma.videoRoomRankingAggregationLog.updateMany.mockResolvedValue({ count: 3 });
      await expect(repo.invalidateAggregation(KEY, 'boom')).resolves.toBe(3);
    });

    it('truncates an oversized reason to 1000 characters, like failAggregation does', async () => {
      const longReason = 'x'.repeat(1200);
      await repo.invalidateAggregation(KEY, longReason);
      const call = prisma.videoRoomRankingAggregationLog.updateMany.mock.calls[0][0];
      expect(call.data.error).toHaveLength(1000);
    });
  });

  describe('aggregateGiftCoinsBySender', () => {
    it('groups VIDEO_ROOM gifts in the window by sender', async () => {
      prisma.giftTransaction.groupBy.mockResolvedValue([
        { senderId: 'u1', _sum: { totalCoinValue: 500n }, _count: { _all: 3 } },
      ]);
      await expect(repo.aggregateGiftCoinsBySender(WINDOW)).resolves.toEqual([
        { userId: 'u1', coins: 500n, gifts: 3 },
      ]);
      const args = prisma.giftTransaction.groupBy.mock.calls[0][0];
      expect(args.where.contextType).toBe('VIDEO_ROOM');
      expect(args.where.status).toBe('COMPLETED');
      expect(args.where.createdAt).toEqual({ gte: WINDOW.start, lt: WINDOW.end });
      expect(args.where.contextId).toBeUndefined();
    });

    it('scopes to one room when a roomId is given', async () => {
      await repo.aggregateGiftCoinsBySender(WINDOW, 'room-1');
      expect(prisma.giftTransaction.groupBy.mock.calls[0][0].where.contextId).toBe('room-1');
    });

    it('coerces a null sum to zero rather than emitting null coins', async () => {
      prisma.giftTransaction.groupBy.mockResolvedValue([
        { senderId: 'u1', _sum: { totalCoinValue: null }, _count: { _all: 0 } },
      ]);
      await expect(repo.aggregateGiftCoinsBySender(WINDOW)).resolves.toEqual([
        { userId: 'u1', coins: 0n, gifts: 0 },
      ]);
    });
  });

  describe('aggregateGiftCoinsByReceiver', () => {
    it('groups VIDEO_ROOM gifts in the window by receiver', async () => {
      prisma.giftTransaction.groupBy.mockResolvedValue([
        { receiverId: 'u2', _sum: { totalCoinValue: 300n }, _count: { _all: 2 } },
      ]);
      await expect(repo.aggregateGiftCoinsByReceiver(WINDOW)).resolves.toEqual([
        { userId: 'u2', coins: 300n, gifts: 2 },
      ]);
      const args = prisma.giftTransaction.groupBy.mock.calls[0][0];
      expect(args.by).toEqual(['receiverId']);
      expect(args.where.contextType).toBe('VIDEO_ROOM');
      expect(args.where.status).toBe('COMPLETED');
      expect(args.where.createdAt).toEqual({ gte: WINDOW.start, lt: WINDOW.end });
      expect(args.where.contextId).toBeUndefined();
    });

    it('scopes to one room when a roomId is given', async () => {
      await repo.aggregateGiftCoinsByReceiver(WINDOW, 'room-1');
      expect(prisma.giftTransaction.groupBy.mock.calls[0][0].where.contextId).toBe('room-1');
    });

    it('coerces a null sum to zero rather than emitting null coins', async () => {
      prisma.giftTransaction.groupBy.mockResolvedValue([
        { receiverId: 'u2', _sum: { totalCoinValue: null }, _count: { _all: 0 } },
      ]);
      await expect(repo.aggregateGiftCoinsByReceiver(WINDOW)).resolves.toEqual([
        { userId: 'u2', coins: 0n, gifts: 0 },
      ]);
    });
  });

  describe('aggregateGiftCoinsByRoom', () => {
    it('groups VIDEO_ROOM gifts in the window by contextId and returns it as roomId', async () => {
      prisma.giftTransaction.groupBy.mockResolvedValue([
        { contextId: 'room-1', _sum: { totalCoinValue: 700n }, _count: { _all: 4 } },
      ]);
      await expect(repo.aggregateGiftCoinsByRoom(WINDOW)).resolves.toEqual([
        { roomId: 'room-1', coins: 700n, gifts: 4 },
      ]);
      const args = prisma.giftTransaction.groupBy.mock.calls[0][0];
      expect(args.by).toEqual(['contextId']);
      expect(args.where.contextType).toBe('VIDEO_ROOM');
      expect(args.where.status).toBe('COMPLETED');
      expect(args.where.createdAt).toEqual({ gte: WINDOW.start, lt: WINDOW.end });
    });

    it('coerces a null sum to zero rather than emitting null coins', async () => {
      prisma.giftTransaction.groupBy.mockResolvedValue([
        { contextId: 'room-1', _sum: { totalCoinValue: null }, _count: { _all: 0 } },
      ]);
      await expect(repo.aggregateGiftCoinsByRoom(WINDOW)).resolves.toEqual([
        { roomId: 'room-1', coins: 0n, gifts: 0 },
      ]);
    });
  });

  describe('aggregatePkOutcomes', () => {
    it('returns [] without querying participants or contributions when no battle completed in the window', async () => {
      prisma.videoRoomPkBattle.findMany.mockResolvedValue([]);
      await expect(repo.aggregatePkOutcomes(WINDOW)).resolves.toEqual([]);
      expect(prisma.videoRoomPkParticipant.findMany).not.toHaveBeenCalled();
      expect(prisma.videoRoomPkContribution.groupBy).not.toHaveBeenCalled();
    });

    it('queries battles COMPLETED within the half-open completedAt window', async () => {
      await repo.aggregatePkOutcomes(WINDOW);
      const args = prisma.videoRoomPkBattle.findMany.mock.calls[0][0];
      expect(args.where.status).toBe('COMPLETED');
      expect(args.where.completedAt).toEqual({ gte: WINDOW.start, lt: WINDOW.end });
    });

    it('credits a win to the participant on the winning team and a loss to the other', async () => {
      prisma.videoRoomPkBattle.findMany.mockResolvedValue([
        { id: 'b1', winningTeamId: 't1', isDraw: false },
      ]);
      prisma.videoRoomPkParticipant.findMany.mockResolvedValue([
        { id: 'p1', battleId: 'b1', userId: 'u1', teamId: 't1', score: 100n },
        { id: 'p2', battleId: 'b1', userId: 'u2', teamId: 't2', score: 80n },
      ]);
      prisma.videoRoomPkContribution.groupBy.mockResolvedValue([
        { participantId: 'p1', _sum: { baseAmount: 100n } },
        { participantId: 'p2', _sum: { baseAmount: 80n } },
      ]);

      const result = await repo.aggregatePkOutcomes(WINDOW);
      expect(result).toHaveLength(2);
      expect(result).toEqual(
        expect.arrayContaining([
          { userId: 'u1', wins: 1, losses: 0, score: 100n, giftCoins: 100n },
          { userId: 'u2', wins: 0, losses: 1, score: 80n, giftCoins: 80n },
        ]),
      );
    });

    it('counts a draw as neither a win nor a loss', async () => {
      prisma.videoRoomPkBattle.findMany.mockResolvedValue([
        { id: 'b1', winningTeamId: null, isDraw: true },
      ]);
      prisma.videoRoomPkParticipant.findMany.mockResolvedValue([
        { id: 'p1', battleId: 'b1', userId: 'u1', teamId: 't1', score: 50n },
      ]);
      prisma.videoRoomPkContribution.groupBy.mockResolvedValue([
        { participantId: 'p1', _sum: { baseAmount: 50n } },
      ]);

      await expect(repo.aggregatePkOutcomes(WINDOW)).resolves.toEqual([
        { userId: 'u1', wins: 0, losses: 0, score: 50n, giftCoins: 50n },
      ]);
    });

    it('gives a participant with no contributions a giftCoins of 0n, not undefined', async () => {
      prisma.videoRoomPkBattle.findMany.mockResolvedValue([
        { id: 'b1', winningTeamId: 't1', isDraw: false },
      ]);
      prisma.videoRoomPkParticipant.findMany.mockResolvedValue([
        { id: 'p1', battleId: 'b1', userId: 'u1', teamId: 't1', score: 40n },
      ]);
      prisma.videoRoomPkContribution.groupBy.mockResolvedValue([]);

      await expect(repo.aggregatePkOutcomes(WINDOW)).resolves.toEqual([
        { userId: 'u1', wins: 1, losses: 0, score: 40n, giftCoins: 0n },
      ]);
    });

    // Finding 1 regression guard: `score` is `baseAmount * multiplierBps /
    // 10000`, so a VIP tier or event bonus inflates it above the true coin
    // value. `giftCoins` must reflect the RAW baseAmount from
    // VideoRoomPkContribution, never the multiplied score.
    it('does NOT equate giftCoins with the multiplier-inflated score', async () => {
      prisma.videoRoomPkBattle.findMany.mockResolvedValue([
        { id: 'b1', winningTeamId: 't1', isDraw: false },
      ]);
      // A 2x multiplier doubled scoredAmount (== participant.score) to 100n,
      // while the real coin baseAmount behind that contribution was only 50n.
      prisma.videoRoomPkParticipant.findMany.mockResolvedValue([
        { id: 'p1', battleId: 'b1', userId: 'u1', teamId: 't1', score: 100n },
      ]);
      prisma.videoRoomPkContribution.groupBy.mockResolvedValue([
        { participantId: 'p1', _sum: { baseAmount: 50n } },
      ]);

      const [entry] = await repo.aggregatePkOutcomes(WINDOW);
      expect(entry.score).toBe(100n);
      expect(entry.giftCoins).toBe(50n);
      expect(entry.giftCoins).not.toBe(entry.score);
    });

    it('sums contribution baseAmount for the window battles, grouped by participantId', async () => {
      prisma.videoRoomPkBattle.findMany.mockResolvedValue([
        { id: 'b1', winningTeamId: 't1', isDraw: false },
      ]);
      prisma.videoRoomPkParticipant.findMany.mockResolvedValue([
        { id: 'p1', battleId: 'b1', userId: 'u1', teamId: 't1', score: 10n },
      ]);

      await repo.aggregatePkOutcomes(WINDOW);
      const args = prisma.videoRoomPkContribution.groupBy.mock.calls[0][0];
      expect(args.by).toEqual(['participantId']);
      expect(args.where).toEqual({ battleId: { in: ['b1'] } });
      expect(args._sum).toEqual({ baseAmount: true });
    });
  });

  describe('aggregateTreasureWinnings', () => {
    it('groups treasure winnings in the half-open selectedAt window by user', async () => {
      prisma.treasureWinner.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { amount: 250n }, _count: { _all: 2 } },
      ]);
      await expect(repo.aggregateTreasureWinnings(WINDOW)).resolves.toEqual([
        { userId: 'u1', coins: 250n, events: 2 },
      ]);
      const args = prisma.treasureWinner.groupBy.mock.calls[0][0];
      expect(args.by).toEqual(['userId']);
      expect(args.where.selectedAt).toEqual({ gte: WINDOW.start, lt: WINDOW.end });
    });

    it('coerces a null sum to zero rather than emitting null coins', async () => {
      prisma.treasureWinner.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { amount: null }, _count: { _all: 0 } },
      ]);
      await expect(repo.aggregateTreasureWinnings(WINDOW)).resolves.toEqual([
        { userId: 'u1', coins: 0n, events: 0 },
      ]);
    });
  });

  describe('findRoomStatistics', () => {
    it('short-circuits to an empty array on an empty room id list, issuing no query', async () => {
      await expect(repo.findRoomStatistics([])).resolves.toEqual([]);
      expect(prisma.videoRoomStatistics.findMany).not.toHaveBeenCalled();
    });

    it('selects roomId, peakViewers, avgWatchTimeSeconds and totalPkCount for the given rooms', async () => {
      prisma.videoRoomStatistics.findMany.mockResolvedValue([
        { roomId: 'room-1', peakViewers: 42, avgWatchTimeSeconds: 120, totalPkCount: 3 },
      ]);
      await expect(repo.findRoomStatistics(['room-1'])).resolves.toEqual([
        { roomId: 'room-1', peakViewers: 42, avgWatchTimeSeconds: 120, totalPkCount: 3 },
      ]);
      expect(prisma.videoRoomStatistics.findMany).toHaveBeenCalledWith({
        where: { roomId: { in: ['room-1'] } },
        select: {
          roomId: true,
          peakViewers: true,
          avgWatchTimeSeconds: true,
          totalPkCount: true,
        },
      });
    });
  });

  describe('pruneSnapshots', () => {
    it('deletes only the given period older than the cutoff', async () => {
      const cutoff = new Date('2026-01-01T00:00:00Z');
      await expect(repo.pruneSnapshots('hourly', cutoff)).resolves.toBe(5);
      expect(prisma.videoRoomRankingSnapshot.deleteMany).toHaveBeenCalledWith({
        where: { period: 'hourly', createdAt: { lt: cutoff } },
      });
    });
  });

  // ================= hydrateTargets (not in the brief; added per Task 9 addendum) =================

  describe('hydrateTargets', () => {
    it('joins user, profile and statistics for a user ladder in one pass', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'u1', username: 'alice' }]);
      prisma.userProfile.findMany.mockResolvedValue([{ userId: 'u1', avatarKey: 'avatar/u1.png' }]);
      prisma.userStatistics.findMany.mockResolvedValue([
        { userId: 'u1', level: 12, wealthLevel: 3 },
      ]);

      await expect(repo.hydrateTargets(['u1'], 'user')).resolves.toEqual([
        { id: 'u1', username: 'alice', avatarKey: 'avatar/u1.png', level: 12, vipLevel: 3 },
      ]);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('defaults level to 1 and vipLevel to 0 when the profile/statistics rows are missing', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'u1', username: 'alice' }]);
      prisma.userProfile.findMany.mockResolvedValue([]);
      prisma.userStatistics.findMany.mockResolvedValue([]);

      await expect(repo.hydrateTargets(['u1'], 'user')).resolves.toEqual([
        { id: 'u1', username: 'alice', avatarKey: null, level: 1, vipLevel: 0 },
      ]);
    });

    it('hydrates a room ladder from VideoRoom, mapping name to username and imageKey to avatarKey', async () => {
      prisma.videoRoom.findMany.mockResolvedValue([
        { id: 'r1', name: 'Chill Room', imageKey: 'rooms/r1.png' },
      ]);

      await expect(repo.hydrateTargets(['r1'], 'room')).resolves.toEqual([
        { id: 'r1', username: 'Chill Room', avatarKey: 'rooms/r1.png', level: 0, vipLevel: 0 },
      ]);
    });

    it('short-circuits to an empty array on an empty id list without querying', async () => {
      await expect(repo.hydrateTargets([], 'user')).resolves.toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.videoRoom.findMany).not.toHaveBeenCalled();

      await expect(repo.hydrateTargets([], 'room')).resolves.toEqual([]);
      expect(prisma.videoRoom.findMany).not.toHaveBeenCalled();
    });
  });
});
