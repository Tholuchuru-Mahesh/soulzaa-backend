import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TreasureBox,
  TreasureBoxStatus,
  TreasureSession,
  TreasureSessionStatus,
  VideoRoomMemberStatus,
  VideoRoomModerationStatus,
  VideoRoomTreasureLevel,
  VideoRoomTreasureSession,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TREASURE_CONTEXT_TYPE } from '../constants/video-room-treasure.constants';

type Db = Prisma.TransactionClient | PrismaService;

/** States in which a room already holds a ladder and cannot create another. */
export const LIVE_SESSION_STATES: TreasureSessionStatus[] = [
  TreasureSessionStatus.DRAFT,
  TreasureSessionStatus.ACTIVE,
  TreasureSessionStatus.PAUSED,
];

/**
 * Persistence for the video-room treasure ladder (VR-11).
 *
 * Every read of a SHARED table (TreasureSession / TreasureBox /
 * TreasureContribution) is scoped by roomId + contextType, or by an id only
 * reachable from a video session — so this repository can never observe or
 * mutate an audio-room row.
 *
 * The two mutators that matter for concurrency — `addProgress` and
 * `claimUnlock` — are conditional `updateMany` calls returning null/false
 * rather than throwing. Losing that race is the normal path under load, not an
 * exception, and keeping the decision at the call site is what lets the caller
 * re-read and retry.
 */
@Injectable()
export class VideoRoomTreasureRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Db): Db {
    return tx ?? this.prisma;
  }

  // ---- Levels ----

  listEnabledLevels(): Promise<VideoRoomTreasureLevel[]> {
    return this.prisma.videoRoomTreasureLevel.findMany({
      where: { enabled: true },
      orderBy: { level: 'asc' },
    });
  }

  /** Idempotent by level: an existing level is never overwritten, so operator tuning survives a redeploy. */
  async seedLevel(
    level: number,
    data: Omit<Prisma.VideoRoomTreasureLevelUncheckedCreateInput, 'level'>,
  ): Promise<boolean> {
    const existing = await this.prisma.videoRoomTreasureLevel.count({ where: { level } });
    if (existing > 0) return false;
    await this.prisma.videoRoomTreasureLevel.create({ data: { level, ...data } });
    return true;
  }

  // ---- Sessions ----

  /**
   * Creates the session, its video-only extension row (holding the frozen level
   * snapshot) and every box, in one transaction.
   *
   * All boxes start PENDING. `start` promotes level 1 to ACTIVE, so a DRAFT
   * ladder cannot absorb progress from a gift that lands between create and start.
   */
  async createSession(input: {
    roomId: string;
    createdBy: string;
    levelSnapshot: Prisma.InputJsonValue;
    boxes: { level: number; threshold: bigint }[];
  }): Promise<TreasureSession> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.treasureSession.create({
        data: {
          roomId: input.roomId,
          startedBy: input.createdBy,
          contextType: TREASURE_CONTEXT_TYPE,
          status: TreasureSessionStatus.DRAFT,
          currentLevel: 1,
        },
      });
      await tx.videoRoomTreasureSession.create({
        data: {
          sessionId: session.id,
          roomId: input.roomId,
          levelSnapshot: input.levelSnapshot,
          createdBy: input.createdBy,
        },
      });
      await tx.treasureBox.createMany({
        data: input.boxes.map((b) => ({
          sessionId: session.id,
          roomId: input.roomId,
          level: b.level,
          threshold: b.threshold,
          status: TreasureBoxStatus.PENDING,
        })),
      });
      return session;
    });
  }

  findCurrentSession(roomId: string, tx?: Db): Promise<TreasureSession | null> {
    return this.db(tx).treasureSession.findFirst({
      where: {
        roomId,
        contextType: TREASURE_CONTEXT_TYPE,
        status: { in: LIVE_SESSION_STATES },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  getSession(sessionId: string): Promise<TreasureSession | null> {
    return this.prisma.treasureSession.findUnique({ where: { id: sessionId } });
  }

  getSnapshot(sessionId: string): Promise<VideoRoomTreasureSession | null> {
    return this.prisma.videoRoomTreasureSession.findUnique({ where: { sessionId } });
  }

  /**
   * Conditional state transition. Returns the session on success, null when it
   * was not in `from` — which is how two concurrent owner commands are resolved
   * without a lock: exactly one caller sees a non-null result.
   */
  async transitionSession(
    sessionId: string,
    from: TreasureSessionStatus[],
    to: TreasureSessionStatus,
    tx?: Db,
  ): Promise<TreasureSession | null> {
    const db = this.db(tx);
    const data: Prisma.TreasureSessionUncheckedUpdateManyInput = { status: to };
    if (to === TreasureSessionStatus.COMPLETED || to === TreasureSessionStatus.CLOSED) {
      data.completedAt = new Date();
    }
    const res = await db.treasureSession.updateMany({
      where: { id: sessionId, status: { in: from } },
      data,
    });
    if (res.count === 0) return null;
    return db.treasureSession.findUnique({ where: { id: sessionId } });
  }

  async setSessionLevel(sessionId: string, currentLevel: number, tx?: Db): Promise<void> {
    await this.db(tx).treasureSession.update({
      where: { id: sessionId },
      data: { currentLevel },
    });
  }

  listSessions(roomId: string, skip: number, take: number): Promise<[TreasureSession[], number]> {
    const where: Prisma.TreasureSessionWhereInput = {
      roomId,
      contextType: TREASURE_CONTEXT_TYPE,
    };
    return this.prisma.$transaction([
      this.prisma.treasureSession.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.treasureSession.count({ where }),
    ]);
  }

  // ---- Boxes ----

  listBoxes(sessionId: string, tx?: Db): Promise<TreasureBox[]> {
    return this.db(tx).treasureBox.findMany({
      where: { sessionId },
      orderBy: { level: 'asc' },
    });
  }

  getBox(boxId: string, tx?: Db): Promise<TreasureBox | null> {
    return this.db(tx).treasureBox.findUnique({ where: { id: boxId } });
  }

  /**
   * Compare-and-set progress. `observed` is the value the caller read; if
   * another transaction changed it first the update matches nothing and we
   * return null so the caller re-reads. This is what makes concurrent gifts to
   * one box correct without a distributed lock.
   */
  async addProgress(
    boxId: string,
    observed: bigint,
    delta: bigint,
    tx: Db,
  ): Promise<TreasureBox | null> {
    const res = await tx.treasureBox.updateMany({
      where: { id: boxId, progress: observed },
      data: { progress: observed + delta },
    });
    if (res.count === 0) return null;
    return tx.treasureBox.findUnique({ where: { id: boxId } });
  }

  /** ACTIVE → UNLOCKING. True for exactly one caller: the unlock owner. */
  async claimUnlock(boxId: string, tx?: Db): Promise<boolean> {
    const res = await this.db(tx).treasureBox.updateMany({
      where: { id: boxId, status: TreasureBoxStatus.ACTIVE },
      data: { status: TreasureBoxStatus.UNLOCKING },
    });
    return res.count === 1;
  }

  async openBox(boxId: string, tx: Db): Promise<void> {
    await tx.treasureBox.updateMany({
      where: { id: boxId, status: TreasureBoxStatus.UNLOCKING },
      data: { status: TreasureBoxStatus.OPENED, openedAt: new Date() },
    });
  }

  async activateBox(boxId: string, tx?: Db): Promise<void> {
    await this.db(tx).treasureBox.updateMany({
      where: { id: boxId, status: TreasureBoxStatus.PENDING },
      data: { status: TreasureBoxStatus.ACTIVE },
    });
  }

  /**
   * Boxes stuck UNLOCKING past the orphan timeout — the process died between
   * the claim (which committed with the gift) and the job running, so BullMQ
   * never saw a job and its retry cannot help. The pool-row check lives in the
   * recovery service, which owns the reward repository.
   */
  findOrphanedBoxes(olderThan: Date, limit: number): Promise<TreasureBox[]> {
    return this.prisma.treasureBox.findMany({
      where: { status: TreasureBoxStatus.UNLOCKING, createdAt: { lte: olderThan } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  // ---- Contributions ----

  async addContribution(
    input: {
      boxId: string;
      sessionId: string;
      roomId: string;
      userId: string;
      amount: bigint;
      giftTxnId: string | null;
    },
    tx: Db,
  ): Promise<void> {
    await tx.treasureContribution.create({ data: input });
  }

  /** Per-user totals for one box — feeds the weighted and contribution-based draws. */
  async contributionTotals(boxId: string, tx?: Db): Promise<{ userId: string; amount: bigint }[]> {
    const grouped = await this.db(tx).treasureContribution.groupBy({
      by: ['userId'],
      where: { boxId },
      _sum: { amount: true },
    });
    return grouped.map((g) => ({ userId: g.userId, amount: g._sum.amount ?? 0n }));
  }

  // ---- Eligibility reads ----

  /**
   * Candidates who are genuinely still in the room and entitled to win.
   *
   * `memberStatus: ACTIVE` is checked ALONGSIDE `isActive`, not instead of it:
   * REMOVED is the durable "removed by a moderator (kick/block)" status, and a
   * kicked member whose live `isActive` flag was not cleared would otherwise
   * stay eligible — the brief lists "Not Kicked" as its own rule, separate from
   * "Not Banned".
   */
  async findEligibleMembers(
    roomId: string,
    userIds: string[],
    joinedBefore: Date,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.prisma.videoRoomMember.findMany({
      where: {
        roomId,
        userId: { in: userIds },
        isActive: true,
        memberStatus: VideoRoomMemberStatus.ACTIVE,
        joinedAt: { lte: joinedBefore },
      },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** Users among `userIds` with a live block on this room. */
  async findBlockedUserIds(roomId: string, userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.prisma.videoRoomBlock.findMany({
      where: {
        roomId,
        userId: { in: userIds },
        status: VideoRoomModerationStatus.ACTIVE,
      },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }
}
