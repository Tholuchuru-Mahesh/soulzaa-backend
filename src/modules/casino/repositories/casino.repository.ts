import { Injectable } from '@nestjs/common';
import {
  CasinoBet,
  CasinoBetStatus,
  CasinoGame,
  CasinoRound,
  CasinoRoundStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** A single row of a user's casino win history (derived from `CasinoBet`, no separate table). */
export interface CasinoWinHistoryEntry {
  roundId: string;
  item: string;
  betAmount: number;
  payout: number;
  multiplier: number;
  createdAt: Date;
}

/**
 * Persistence for house-banked casino rounds/bets (Greedy Food, Lucky Fruit) —
 * see docs/superpowers/specs/2026-07-16-greedy-food-lucky-fruit-casino-design.md §5.6.
 *
 * `CasinoBet.betAmount`/`payoutAmount` are `BigInt` columns, but casino stakes are
 * small chip denominations (GOLD only), so the service-facing boundary here takes/
 * returns `number` — mirrored 1:1 to/from `BigInt` at the read/write edge, never
 * coercing a full wallet balance. Win history has no dedicated table: it's just
 * `CasinoBet` rows with `status = WON`, ordered by `createdAt desc`.
 */
@Injectable()
export class CasinoRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Run settlement writes atomically — same pattern as games.repository.ts. */
  runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(tx));
  }

  // ======================= Rounds =======================

  async createRound(game: CasinoGame): Promise<CasinoRound> {
    const count = await this.prisma.casinoRound.count({ where: { game } });
    return this.prisma.casinoRound.create({
      data: {
        game,
        status: CasinoRoundStatus.BETTING,
        roundNumber: count + 1,
      },
    });
  }

  getRound(id: string): Promise<CasinoRound | null> {
    return this.prisma.casinoRound.findUnique({ where: { id } });
  }

  async closeRound(
    id: string,
    status: CasinoRoundStatus,
    winningOutcome: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await (tx ?? this.prisma).casinoRound.update({
      where: { id },
      data: { status, winningOutcome, settledAt: new Date() },
    });
  }

  // ======================= Bets =======================

  /**
   * Idempotent on `(roundId, userId, clientBetId)` — the row-level anchor for
   * faithful bet stacking (see the model doc comment on `CasinoBet.clientBetId`).
   * A replay of the same tap (same triple) returns the EXISTING row rather
   * than inserting a duplicate; a genuinely new tap (new `clientBetId`) on
   * the same item creates a second, stacked row. Races the insert instead of
   * pre-checking: catches the unique-violation (P2002) and re-fetches, so a
   * concurrent double-submit still converges on one row.
   */
  async createBet(
    input: {
      roundId: string;
      userId: string;
      game: CasinoGame;
      betItem: string;
      betAmount: number;
      clientBetId: string;
      betTxnId?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<CasinoBet> {
    const client = tx ?? this.prisma;
    try {
      return await client.casinoBet.create({
        data: {
          roundId: input.roundId,
          userId: input.userId,
          game: input.game,
          betItem: input.betItem,
          betAmount: BigInt(input.betAmount),
          clientBetId: input.clientBetId,
          betTxnId: input.betTxnId,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await client.casinoBet.findUnique({
          where: {
            roundId_userId_clientBetId: {
              roundId: input.roundId,
              userId: input.userId,
              clientBetId: input.clientBetId,
            },
          },
        });
        if (existing) return existing;
      }
      throw e;
    }
  }

  listPlacedBets(roundId: string, tx?: Prisma.TransactionClient): Promise<CasinoBet[]> {
    return (tx ?? this.prisma).casinoBet.findMany({
      where: { roundId, status: CasinoBetStatus.PLACED },
    });
  }

  /**
   * ONE user's still-`PLACED` bets in ONE round — the gateway's `*_sync`
   * `myBets` field (see the old apps' "Filter user's active bets in current
   * round" in `join_greedy_food`/`join_lucky_fruit`). Every stacked tap on the
   * same item is its own row (distinct `clientBetId`), so a user who tapped
   * `crab` three times gets three rows back here, exactly like the old
   * in-memory `activeBets.filter(b => b.userId === userId)`.
   */
  listUserBets(roundId: string, userId: string): Promise<CasinoBet[]> {
    return this.prisma.casinoBet.findMany({
      where: { roundId, userId, status: CasinoBetStatus.PLACED },
    });
  }

  /** Distinct symbols/items a user has already staked on within this round (Lucky Fruit's ≤6-distinct rule). */
  async countDistinctSymbols(roundId: string, userId: string): Promise<number> {
    const rows = await this.prisma.casinoBet.findMany({
      where: { roundId, userId },
      distinct: ['betItem'],
      select: { betItem: true },
    });
    return rows.length;
  }

  /**
   * Whether the user already has a bet on `item` in this round — lets the
   * Lucky Fruit ≤6-distinct cap allow adding MORE to an already-bet symbol
   * even once the cap is reached, and only reject a brand-new 7th symbol
   * (matches the old app's `!uniqueSymbols.has(symbol) && uniqueSymbols.size >= 6`).
   */
  async hasSymbol(roundId: string, userId: string, item: string): Promise<boolean> {
    const existing = await this.prisma.casinoBet.findFirst({
      where: { roundId, userId, betItem: item },
      select: { id: true },
    });
    return existing !== null;
  }

  async updateBet(
    id: string,
    data: Partial<{
      status: CasinoBetStatus;
      payoutAmount: number;
      winTxnId: string;
      settledAt: Date;
    }>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await (tx ?? this.prisma).casinoBet.update({
      where: { id },
      data: {
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.payoutAmount != null ? { payoutAmount: BigInt(data.payoutAmount) } : {}),
        ...(data.winTxnId !== undefined ? { winTxnId: data.winTxnId } : {}),
        ...(data.settledAt !== undefined ? { settledAt: data.settledAt } : {}),
      },
    });
  }

  /**
   * Last `limit` WON bets across ALL players of `game`, newest first — raw
   * material for the sync payload's `recentWinners` feed (see the old apps'
   * `getRecentWinners`: a cross-user "last 10 wins" ticker, joined against a
   * username table there; here the gateway resolves display names itself via
   * `IProfileService` and formats the display string, so this stays a plain
   * data query). `payoutAmount: { gt: 0 }` mirrors the old query's guard even
   * though `status: WON` alone already implies a positive payout (see
   * `CasinoService.settleRound`) — belt-and-suspenders, matching old exactly.
   */
  async recentWinningBets(
    game: CasinoGame,
    limit: number,
  ): Promise<Array<{ userId: string; betItem: string; payoutAmount: number }>> {
    const rows = await this.prisma.casinoBet.findMany({
      where: { game, status: CasinoBetStatus.WON, payoutAmount: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { userId: true, betItem: true, payoutAmount: true },
    });
    return rows.map((r) => ({
      userId: r.userId,
      betItem: r.betItem,
      payoutAmount: Number(r.payoutAmount),
    }));
  }

  // ======================= Win history =======================

  async winHistory(
    userId: string,
    game: CasinoGame,
    limit: number,
  ): Promise<CasinoWinHistoryEntry[]> {
    const rows = await this.prisma.casinoBet.findMany({
      where: { userId, game, status: CasinoBetStatus.WON },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => {
      const betAmount = Number(r.betAmount);
      const payout = Number(r.payoutAmount);
      return {
        roundId: r.roundId,
        item: r.betItem,
        betAmount,
        payout,
        multiplier: betAmount ? Math.round(payout / betAmount) : 0,
        createdAt: r.createdAt,
      };
    });
  }
}
