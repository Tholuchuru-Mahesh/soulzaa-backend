import { Injectable } from '@nestjs/common';
import {
  Prisma,
  VideoRoomPkBattle,
  VideoRoomPkContribution,
  VideoRoomPkParticipant,
  VideoRoomPkStatus,
  VideoRoomPkTeam,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { PK_TERMINAL_STATUSES } from '../constants/video-room-pk.constants';

export type Db = Prisma.TransactionClient | PrismaService;

/**
 * Persistence for the video-room PK battle engine (VR-12): battles, their
 * two teams, per-user participants and the append-only gift-contribution
 * ledger.
 *
 * The two mutators that carry the concurrency weight are `transition` and
 * the CAS score writers (`addTeamScore` / `addParticipantScore`). All three
 * use `updateMany` with the "expected" value folded into the WHERE clause
 * and report loss as `null`, never as a thrown exception — losing a race is
 * the normal path under load, and keeping that decision at the call site is
 * what lets the caller re-read and retry instead of crashing.
 *
 * No business logic lives here: no FSM validation, no domain exceptions.
 * That belongs to the services that call this repository.
 */
@Injectable()
export class VideoRoomPkRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Transaction boundary for a caller that needs several of THIS repository's
   * own methods to commit atomically (Task 17's `VideoRoomPkService.invite`:
   * battle + teams + participants in one transaction). Mirrors
   * `CasinoRepository.runInTransaction` / `GamesRepository.runInTransaction`
   * exactly — the house convention for keeping `$transaction` out of
   * services while still letting a service compose repository calls against
   * one shared transaction client.
   */
  runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(tx));
  }

  // ---- Battles ----

  findLive(roomId: string, db: Db = this.prisma): Promise<VideoRoomPkBattle | null> {
    return db.videoRoomPkBattle.findFirst({
      where: { roomId, status: VideoRoomPkStatus.LIVE },
    });
  }

  /** Any non-terminal battle for the room — used to enforce "one battle at a time". */
  findCurrent(roomId: string, db: Db = this.prisma): Promise<VideoRoomPkBattle | null> {
    return db.videoRoomPkBattle.findFirst({
      where: {
        roomId,
        status: {
          notIn: [
            VideoRoomPkStatus.COMPLETED,
            VideoRoomPkStatus.CANCELLED,
            VideoRoomPkStatus.FAILED,
          ],
        },
      },
    });
  }

  getBattle(id: string, db: Db = this.prisma): Promise<VideoRoomPkBattle | null> {
    return db.videoRoomPkBattle.findUnique({ where: { id } });
  }

  createBattle(
    data: Prisma.VideoRoomPkBattleUncheckedCreateInput,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkBattle> {
    return db.videoRoomPkBattle.create({ data });
  }

  /**
   * Conditional status transition. Returns the updated row, or null when the
   * battle was no longer in `from` — which means another actor moved it first.
   *
   * `updateMany` rather than `update` is deliberate: `update` throws P2025 on a
   * miss, which would turn an ordinary lost race into an exception the caller
   * has to string-match; and the `status: from` predicate is what actually
   * settles a race between two pods. `count === 0` is the clean signal.
   */
  async transition(
    id: string,
    from: VideoRoomPkStatus,
    to: VideoRoomPkStatus,
    patch: Prisma.VideoRoomPkBattleUpdateInput = {},
    db: Db = this.prisma,
  ): Promise<VideoRoomPkBattle | null> {
    const { count } = await db.videoRoomPkBattle.updateMany({
      where: { id, status: from },
      data: { ...patch, status: to },
    });
    if (count === 0) return null;
    return db.videoRoomPkBattle.findUnique({ where: { id } });
  }

  // ---- Teams ----

  createTeams(
    rows: Prisma.VideoRoomPkTeamCreateManyInput[],
    db: Db = this.prisma,
  ): Promise<Prisma.BatchPayload> {
    return db.videoRoomPkTeam.createMany({ data: rows });
  }

  listTeams(battleId: string, db: Db = this.prisma): Promise<VideoRoomPkTeam[]> {
    return db.videoRoomPkTeam.findMany({ where: { battleId } });
  }

  getTeam(teamId: string, db: Db = this.prisma): Promise<VideoRoomPkTeam | null> {
    return db.videoRoomPkTeam.findUnique({ where: { id: teamId } });
  }

  /**
   * Compare-and-set on the score the caller read. A concurrent writer changes
   * `score`, the WHERE no longer matches, count is 0 and the caller re-reads and
   * retries. Never use `{ increment }` here: it always succeeds, so the caller
   * cannot tell how much of the delta was actually theirs — and the contribution
   * row it then writes would credit this gift with someone else's coins.
   */
  async addTeamScore(
    teamId: string,
    seenScore: bigint,
    delta: bigint,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkTeam | null> {
    const { count } = await db.videoRoomPkTeam.updateMany({
      where: { id: teamId, score: seenScore },
      data: { score: seenScore + delta, giftCount: { increment: 1 } },
    });
    if (count === 0) return null;
    return db.videoRoomPkTeam.findUnique({ where: { id: teamId } });
  }

  // ---- Participants ----

  createParticipants(
    rows: Prisma.VideoRoomPkParticipantCreateManyInput[],
    db: Db = this.prisma,
  ): Promise<Prisma.BatchPayload> {
    return db.videoRoomPkParticipant.createMany({ data: rows });
  }

  listParticipants(battleId: string, db: Db = this.prisma): Promise<VideoRoomPkParticipant[]> {
    return db.videoRoomPkParticipant.findMany({ where: { battleId } });
  }

  findParticipantsByUserIds(
    battleId: string,
    userIds: string[],
    db: Db = this.prisma,
  ): Promise<VideoRoomPkParticipant[]> {
    return db.videoRoomPkParticipant.findMany({
      where: { battleId, userId: { in: userIds } },
    });
  }

  getParticipant(id: string, db: Db = this.prisma): Promise<VideoRoomPkParticipant | null> {
    return db.videoRoomPkParticipant.findUnique({ where: { id } });
  }

  /** Mirrors `addTeamScore` exactly, against `videoRoomPkParticipant`. */
  async addParticipantScore(
    participantId: string,
    seenScore: bigint,
    delta: bigint,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkParticipant | null> {
    const { count } = await db.videoRoomPkParticipant.updateMany({
      where: { id: participantId, score: seenScore },
      data: { score: seenScore + delta, giftCount: { increment: 1 } },
    });
    if (count === 0) return null;
    return db.videoRoomPkParticipant.findUnique({ where: { id: participantId } });
  }

  // ---- Contributions ----

  addContribution(
    data: Prisma.VideoRoomPkContributionUncheckedCreateInput,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkContribution> {
    return db.videoRoomPkContribution.create({ data });
  }

  /**
   * `aggregate` coalesces `null` to `0n`: an empty ledger returns a null sum,
   * and letting `null` propagate into pool arithmetic would produce `NaN`.
   */
  async sumBaseAmount(battleId: string, db: Db = this.prisma): Promise<bigint> {
    const { _sum } = await db.videoRoomPkContribution.aggregate({
      _sum: { baseAmount: true },
      where: { battleId },
    });
    return _sum.baseAmount ?? 0n;
  }

  countGifts(battleId: string, db: Db = this.prisma): Promise<number> {
    return db.videoRoomPkContribution.count({ where: { battleId } });
  }

  /**
   * The original ledger row(s) for one gift, keyed by the SAME
   * `(battleId, giftTxnId)` pair the unique constraint is built on. This is
   * what lets a post-commit reversal (Task 13 `reverse`) negate the EXACT
   * amounts that were actually credited, rather than recomputing a multiplier
   * that may have drifted (VIP tier, config) between the gift and the refund.
   */
  findContributions(
    battleId: string,
    giftTxnId: string,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkContribution[]> {
    return db.videoRoomPkContribution.findMany({ where: { battleId, giftTxnId } });
  }

  async topContributor(
    battleId: string,
    db: Db = this.prisma,
  ): Promise<{ userId: string; total: bigint } | null> {
    const [row] = await db.videoRoomPkContribution.groupBy({
      by: ['senderId'],
      where: { battleId },
      _sum: { baseAmount: true },
      orderBy: { _sum: { baseAmount: 'desc' } },
      take: 1,
    });
    if (!row) return null;
    return { userId: row.senderId, total: row._sum.baseAmount ?? 0n };
  }

  // ---- Wealth Level (read-only borrow) ----

  /**
   * The score strategy must read the sender's Wealth Level through the
   * gift's own transaction client (`ctx.db`), and the wealth module's own
   * repository always binds to the module-level `PrismaService`, never a
   * caller-supplied one — so this PK repository, which already threads `db`
   * through every method, owns the read instead. A user with no
   * `WealthUserProgress` row at all (never purchased) reads back level 0.
   */
  async getWealthLevel(userId: string, db: Db = this.prisma): Promise<number> {
    const p = await db.wealthUserProgress.findUnique({ where: { userId } });
    return p?.currentLevel ?? 0;
  }

  // ---- Listing / recovery ----

  /**
   * Terminal battles only, newest first — backs the history endpoint (VR-12
   * spec §4.3: "PK History — `VideoRoomPkBattle` filtered to terminal
   * statuses"). The filter lives in the WHERE clause, not applied by the
   * caller after the fetch: a still-running battle must never appear in
   * "past battles", and post-fetch filtering would silently desync `total`/
   * pagination from the unfiltered count this query returns.
   */
  listBattles(roomId: string, skip: number, take: number): Promise<[VideoRoomPkBattle[], number]> {
    const where: Prisma.VideoRoomPkBattleWhereInput = {
      roomId,
      status: { in: [...PK_TERMINAL_STATUSES] },
    };
    return this.prisma.$transaction([
      this.prisma.videoRoomPkBattle.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.videoRoomPkBattle.count({ where }),
    ]);
  }

  /**
   * Room-wide, all-time PK aggregates for `VideoRoomPkQueryService.statistics`
   * (Task 21): terminal-battle counts by outcome, plus the total base coins
   * ever contributed and how many gift legs were ever scored. One round trip
   * covering the room's whole history, rather than the caller looping
   * `sumBaseAmount`/`countGifts` (both per-battle) over every past battle.
   */
  async statistics(roomId: string): Promise<{
    totalBattles: number;
    totalWins: number;
    totalDraws: number;
    totalContributed: bigint;
    totalGiftCount: number;
  }> {
    const [totalBattles, totalWins, totalDraws, totalGiftCount, contributed] =
      await this.prisma.$transaction([
        this.prisma.videoRoomPkBattle.count({
          where: { roomId, status: { in: [...PK_TERMINAL_STATUSES] } },
        }),
        this.prisma.videoRoomPkBattle.count({
          where: { roomId, status: VideoRoomPkStatus.COMPLETED, isDraw: false },
        }),
        this.prisma.videoRoomPkBattle.count({
          where: { roomId, status: VideoRoomPkStatus.COMPLETED, isDraw: true },
        }),
        this.prisma.videoRoomPkContribution.count({ where: { roomId } }),
        this.prisma.videoRoomPkContribution.aggregate({
          where: { roomId },
          _sum: { baseAmount: true },
        }),
      ]);
    return {
      totalBattles,
      totalWins,
      totalDraws,
      totalContributed: contributed._sum.baseAmount ?? 0n,
      totalGiftCount,
    };
  }

  /** Battles whose `endsAt` deadline has passed while still in one of `statuses` — feeds the recovery sweep. */
  findStale(now: Date, statuses: VideoRoomPkStatus[], take: number): Promise<VideoRoomPkBattle[]> {
    return this.prisma.videoRoomPkBattle.findMany({
      where: { status: { in: statuses }, endsAt: { lte: now } },
      take,
      orderBy: { endsAt: 'asc' },
    });
  }

  /**
   * Every battle fleet-wide currently sitting in one status, oldest first —
   * the recovery sweep's generic fetch for the three conditions that cannot
   * be expressed as an `endsAt` deadline filter (Task 20): a stalled
   * COUNTDOWN (deadline is `startedAt + countdownSeconds`, not a column),
   * an orphaned RECOVERING (deadline is `pausedAt + orphanTimeoutSeconds`),
   * and a LIVE battle whose room went offline underneath it. The caller
   * applies whichever computed deadline or cross-check the condition needs.
   */
  findByStatus(
    status: VideoRoomPkStatus,
    take: number,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkBattle[]> {
    return db.videoRoomPkBattle.findMany({
      where: { status },
      take,
      orderBy: { createdAt: 'asc' },
    });
  }
}
