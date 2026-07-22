import {
  TreasureBoxStatus,
  TreasureSessionStatus,
  VideoRoomMemberStatus,
  VideoRoomModerationStatus,
} from '@prisma/client';
import { VideoRoomTreasureRepository } from './video-room-treasure.repository';

describe('VideoRoomTreasureRepository', () => {
  let prisma: Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock };
  let repo: VideoRoomTreasureRepository;

  beforeEach(() => {
    prisma = {
      videoRoomTreasureLevel: { findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
      videoRoomTreasureSession: { create: jest.fn(), findUnique: jest.fn() },
      treasureSession: {
        create: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      treasureBox: {
        createMany: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      treasureContribution: { create: jest.fn(), groupBy: jest.fn() },
      videoRoomMember: { findMany: jest.fn().mockResolvedValue([]) },
      videoRoomBlock: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function' ? (arg as (t: unknown) => unknown)(prisma) : Promise.resolve(arg),
      ),
    } as never;
    repo = new VideoRoomTreasureRepository(prisma as never);
  });

  describe('addProgress (compare-and-set)', () => {
    it('returns the updated box when the CAS wins', async () => {
      prisma.treasureBox.updateMany.mockResolvedValue({ count: 1 });
      prisma.treasureBox.findUnique.mockResolvedValue({ id: 'b1', progress: 500n });
      const box = await repo.addProgress('b1', 0n, 500n, prisma as never);
      expect(box).toEqual({ id: 'b1', progress: 500n });
      expect(prisma.treasureBox.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', progress: 0n },
        data: { progress: 500n },
      });
    });

    // Losing the CAS is normal under concurrency, not an error — the caller
    // re-reads and retries. Returning null keeps that decision at the call site.
    it('returns null without a follow-up read when another transaction won', async () => {
      prisma.treasureBox.updateMany.mockResolvedValue({ count: 0 });
      expect(await repo.addProgress('b1', 0n, 500n, prisma as never)).toBeNull();
      expect(prisma.treasureBox.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('claimUnlock', () => {
    it('is true for exactly the transaction that flips ACTIVE to UNLOCKING', async () => {
      prisma.treasureBox.updateMany.mockResolvedValue({ count: 1 });
      expect(await repo.claimUnlock('b1', prisma as never)).toBe(true);
      expect(prisma.treasureBox.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', status: TreasureBoxStatus.ACTIVE },
        data: { status: TreasureBoxStatus.UNLOCKING },
      });
    });

    it('is false for every loser of the race', async () => {
      prisma.treasureBox.updateMany.mockResolvedValue({ count: 0 });
      expect(await repo.claimUnlock('b1', prisma as never)).toBe(false);
    });
  });

  describe('openBox', () => {
    it('only opens a box that is still UNLOCKING, so a replay cannot re-open', async () => {
      prisma.treasureBox.updateMany.mockResolvedValue({ count: 1 });
      await repo.openBox('b1', prisma as never);
      expect(prisma.treasureBox.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', status: TreasureBoxStatus.UNLOCKING },
        data: expect.objectContaining({ status: TreasureBoxStatus.OPENED }),
      });
    });
  });

  describe('transitionSession', () => {
    it('only transitions from an expected source state', async () => {
      prisma.treasureSession.updateMany.mockResolvedValue({ count: 1 });
      prisma.treasureSession.findUnique.mockResolvedValue({ id: 's1' });
      const res = await repo.transitionSession(
        's1',
        [TreasureSessionStatus.ACTIVE],
        TreasureSessionStatus.PAUSED,
      );
      expect(res).toEqual({ id: 's1' });
      expect(prisma.treasureSession.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', status: { in: [TreasureSessionStatus.ACTIVE] } },
        data: { status: TreasureSessionStatus.PAUSED },
      });
    });

    it('returns null when the session was not in an expected state', async () => {
      prisma.treasureSession.updateMany.mockResolvedValue({ count: 0 });
      expect(
        await repo.transitionSession(
          's1',
          [TreasureSessionStatus.ACTIVE],
          TreasureSessionStatus.PAUSED,
        ),
      ).toBeNull();
    });

    it('stamps completedAt for the two terminal states', async () => {
      prisma.treasureSession.updateMany.mockResolvedValue({ count: 1 });
      prisma.treasureSession.findUnique.mockResolvedValue({ id: 's1' });
      for (const to of [TreasureSessionStatus.COMPLETED, TreasureSessionStatus.CLOSED]) {
        await repo.transitionSession('s1', [TreasureSessionStatus.ACTIVE], to);
        expect(prisma.treasureSession.updateMany).toHaveBeenLastCalledWith({
          where: expect.anything(),
          data: expect.objectContaining({ completedAt: expect.any(Date) }),
        });
      }
    });

    it('does not stamp completedAt for a pause', async () => {
      prisma.treasureSession.updateMany.mockResolvedValue({ count: 1 });
      prisma.treasureSession.findUnique.mockResolvedValue({ id: 's1' });
      await repo.transitionSession(
        's1',
        [TreasureSessionStatus.ACTIVE],
        TreasureSessionStatus.PAUSED,
      );
      expect(prisma.treasureSession.updateMany).toHaveBeenCalledWith({
        where: expect.anything(),
        data: { status: TreasureSessionStatus.PAUSED },
      });
    });
  });

  // BC-critical: video queries must be incapable of matching an audio row.
  describe('audio-room isolation', () => {
    it('scopes findCurrentSession by roomId AND contextType', async () => {
      prisma.treasureSession.findFirst.mockResolvedValue(null);
      await repo.findCurrentSession('r1');
      expect(prisma.treasureSession.findFirst).toHaveBeenCalledWith({
        where: {
          roomId: 'r1',
          contextType: 'VIDEO_ROOM',
          status: {
            in: [
              TreasureSessionStatus.DRAFT,
              TreasureSessionStatus.ACTIVE,
              TreasureSessionStatus.PAUSED,
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('scopes listSessions by contextType', async () => {
      prisma.treasureSession.findMany.mockResolvedValue([]);
      prisma.treasureSession.count.mockResolvedValue(0);
      await repo.listSessions('r1', 0, 20);
      expect(prisma.treasureSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { roomId: 'r1', contextType: 'VIDEO_ROOM' } }),
      );
    });
  });

  describe('createSession', () => {
    it('writes the session as VIDEO_ROOM/DRAFT with every box PENDING', async () => {
      prisma.treasureSession.create.mockResolvedValue({ id: 's1' });
      prisma.videoRoomTreasureSession.create.mockResolvedValue({ id: 'x1' });
      prisma.treasureBox.createMany.mockResolvedValue({ count: 2 });

      await repo.createSession({
        roomId: 'r1',
        createdBy: 'u1',
        levelSnapshot: [{ level: 1 }] as never,
        boxes: [
          { level: 1, threshold: 15_000n },
          { level: 2, threshold: 60_000n },
        ],
      });

      expect(prisma.treasureSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          contextType: 'VIDEO_ROOM',
          status: TreasureSessionStatus.DRAFT,
          currentLevel: 1,
        }),
      });
      // Every box PENDING: a DRAFT ladder must not absorb an in-flight gift.
      const boxes = prisma.treasureBox.createMany.mock.calls[0][0].data;
      expect(boxes.every((b: { status: string }) => b.status === TreasureBoxStatus.PENDING)).toBe(
        true,
      );
    });

    it('stores the frozen level snapshot alongside the session', async () => {
      prisma.treasureSession.create.mockResolvedValue({ id: 's1' });
      prisma.videoRoomTreasureSession.create.mockResolvedValue({ id: 'x1' });
      prisma.treasureBox.createMany.mockResolvedValue({ count: 1 });
      await repo.createSession({
        roomId: 'r1',
        createdBy: 'u1',
        levelSnapshot: [{ level: 1, threshold: 15_000 }] as never,
        boxes: [{ level: 1, threshold: 15_000n }],
      });
      expect(prisma.videoRoomTreasureSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: 's1',
          levelSnapshot: [{ level: 1, threshold: 15_000 }],
        }),
      });
    });
  });

  describe('seedLevel', () => {
    it('creates a level that does not exist', async () => {
      prisma.videoRoomTreasureLevel.count.mockResolvedValue(0);
      expect(await repo.seedLevel(1, { threshold: 15_000n } as never)).toBe(true);
      expect(prisma.videoRoomTreasureLevel.create).toHaveBeenCalled();
    });

    // Operator tuning must survive a redeploy.
    it('never overwrites an existing level', async () => {
      prisma.videoRoomTreasureLevel.count.mockResolvedValue(1);
      expect(await repo.seedLevel(1, { threshold: 15_000n } as never)).toBe(false);
      expect(prisma.videoRoomTreasureLevel.create).not.toHaveBeenCalled();
    });
  });

  describe('contributionTotals', () => {
    it('sums per user and defaults a null sum to zero', async () => {
      prisma.treasureContribution.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { amount: 500n } },
        { userId: 'u2', _sum: { amount: null } },
      ]);
      expect(await repo.contributionTotals('b1')).toEqual([
        { userId: 'u1', amount: 500n },
        { userId: 'u2', amount: 0n },
      ]);
    });
  });

  describe('eligibility reads', () => {
    // "Not Kicked" is its own rule in the brief, separate from "Not Banned".
    // REMOVED is the durable moderator-removal status, so checking isActive
    // alone would leave a kicked member eligible to win.
    it('requires BOTH isActive and memberStatus ACTIVE', async () => {
      prisma.videoRoomMember.findMany.mockResolvedValue([{ userId: 'u1' }]);
      const cutoff = new Date(1_700_000_000_000);
      const res = await repo.findEligibleMembers('r1', ['u1', 'u2'], cutoff);
      expect(res).toEqual(['u1']);
      expect(prisma.videoRoomMember.findMany).toHaveBeenCalledWith({
        where: {
          roomId: 'r1',
          userId: { in: ['u1', 'u2'] },
          isActive: true,
          memberStatus: VideoRoomMemberStatus.ACTIVE,
          joinedAt: { lte: cutoff },
        },
        select: { userId: true },
      });
    });

    it('only counts ACTIVE blocks, so a lifted block does not bar a user', async () => {
      prisma.videoRoomBlock.findMany.mockResolvedValue([{ userId: 'u2' }]);
      const res = await repo.findBlockedUserIds('r1', ['u1', 'u2']);
      expect(res).toEqual(new Set(['u2']));
      expect(prisma.videoRoomBlock.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: VideoRoomModerationStatus.ACTIVE }),
        }),
      );
    });

    it('short-circuits an empty candidate list without querying', async () => {
      expect(await repo.findEligibleMembers('r1', [], new Date())).toEqual([]);
      expect(await repo.findBlockedUserIds('r1', [])).toEqual(new Set());
      expect(prisma.videoRoomMember.findMany).not.toHaveBeenCalled();
      expect(prisma.videoRoomBlock.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findOrphanedBoxes', () => {
    it('looks for UNLOCKING boxes older than the cutoff', async () => {
      const cutoff = new Date(1_700_000_000_000);
      prisma.treasureBox.findMany.mockResolvedValue([]);
      await repo.findOrphanedBoxes(cutoff, 50);
      expect(prisma.treasureBox.findMany).toHaveBeenCalledWith({
        where: { status: TreasureBoxStatus.UNLOCKING, createdAt: { lte: cutoff } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
    });
  });
});
