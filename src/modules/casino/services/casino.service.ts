/**
 * Casino service — bet-placement AND settlement for the house-banked games
 * (Greedy Food, Lucky Fruit). Validates a bet exactly like the old socket
 * handlers, performs the real-time GOLD debit (idempotent, via the wallet
 * module), and persists the `CasinoBet` row. Settlement pays winners
 * (server-funded GOLD credit, not a pot redistribution), closes the round,
 * and refunds every bet if the settlement transaction itself fails.
 *
 * Settlement deliberately does NOT select the winning outcome — that is
 * chosen once by the caller (the round loop/scheduler, a later task) via the
 * pure engine selectors (`selectGreedyOutcome`/`selectLuckyOutcome`) at
 * "spin lock" time and broadcast to clients; `settleRound` only ever pays out
 * against that already-fixed outcome (see the old app's `lockRoundAndSpin`
 * vs. `settleRoundAndDisplay` split — re-selecting here could disagree with
 * what was already shown spinning on the wheel).
 *
 * Source of truth for validation order and error text (copied verbatim,
 * unified across both games per the design doc's upgrade — see §5.7) and for
 * the settlement payout math (see §5.5):
 *   - old backend: controller/socket_controllers/greedy_food_socket.js (`place_casino_bet`,
 *     `settleRoundAndDisplay`)
 *   - old backend: controller/socket_controllers/lucky_fruit_socket.js (`place_lucky_fruit_bet`,
 *     its settlement block)
 * See also docs/superpowers/specs/2026-07-16-greedy-food-lucky-fruit-casino-design.md §§5.5, 5.7, 7.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CasinoBet,
  CasinoBetStatus,
  CasinoGame,
  CasinoRoundStatus,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { walletLockKey } from 'src/modules/wallet/constants/wallet.constants';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import {
  casinoBetIdempotencyKey,
  casinoBetLockKey,
  casinoRefundIdempotencyKey,
  casinoWinIdempotencyKey,
  CASINO_CHIPS,
  LUCKY_MAX_SYMBOLS,
  TOP_WINNERS,
  WIN_HISTORY_LIMIT,
  type CasinoPhase,
} from '../constants/casino.constants';
import { greedyEffectiveMultiplier, isGreedyBettable } from '../engines/greedy-food.engine';
import { isLuckyBettable, luckyEffectiveMultiplier } from '../engines/lucky-fruit.engine';
import { CasinoRepository, type CasinoWinHistoryEntry } from '../repositories/casino.repository';

/** All chip whitelist checks compare against this (typed down from the `as const` tuple). */
const VALID_CHIPS: readonly number[] = CASINO_CHIPS;

/**
 * Domain error for the casino bet-placement path — NOT an HTTP exception.
 * The gateway (a later task) catches this and emits it verbatim as the
 * shared `casino_error { message }` socket event, exactly like the old app.
 */
export class CasinoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CasinoError';
  }
}

/**
 * Input for `CasinoService.placeBet`. `activeRoundId`/`phase` describe the
 * caller's (the gateway's) real-time round state — the same in-memory
 * `activeRoundId`/`roundPhase` globals the old socket loop kept — since a
 * round's live betting/spinning/results phase is a timer-driven concept the
 * DB's `CasinoRound.status` does not fully capture (there is no "results" status).
 */
export interface PlaceBetInput {
  userId: string;
  game: CasinoGame;
  /** roundId the client believes is active — must match the caller's `activeRoundId`. */
  roundId: string;
  /** Bet item (Greedy Food) or symbol (Lucky Fruit). */
  item: string;
  amount: number;
  activeRoundId: string | null;
  phase: CasinoPhase;
  /**
   * Per-tap client-supplied id — the faithful-stacking anchor. Each tap on
   * an item is its own bet with its own `clientBetId`, so two taps on the
   * SAME item with DIFFERENT ids both debit and both persist (stacking);
   * replaying the SAME id (e.g. a client retry) is a no-op replay: the
   * wallet debit and the `CasinoBet` row are both idempotent on it, so no
   * second charge and no duplicate row are ever created.
   */
  clientBetId: string;
}

export interface PlaceBetResult {
  balanceAfter: number;
  betId: string;
}

/** Result of `CasinoService.settleRound` — what the gateway broadcasts. */
export interface SettleRoundResult {
  winningOutcome: string;
  /** Per-user TOTAL payout this round (summed across that user's winning bets). */
  payouts: Record<string, number>;
  /** Top `TOP_WINNERS` (3) users by summed payout, descending. */
  winners: Array<{ userId: string; amount: number }>;
  /**
   * True only when the settlement transaction itself failed and every bet
   * was refunded instead (round closed `ABORTED`, not `SETTLED`). `payouts`
   * and `winners` are empty in that case — callers must check this flag to
   * distinguish "settled, nobody won" from "settlement failed, refunded".
   */
  aborted?: boolean;
}

@Injectable()
export class CasinoService {
  private readonly logger = new Logger(CasinoService.name);

  constructor(
    private readonly repo: CasinoRepository,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    private readonly locks: LockService,
  ) {}

  private bettable(game: CasinoGame, item: string): boolean {
    return game === CasinoGame.GREEDY_FOOD ? isGreedyBettable(item) : isLuckyBettable(item);
  }

  /**
   * Validates + places a single bet: phase/round check, chip whitelist,
   * item/symbol bettable, Lucky Fruit's ≤6-distinct-symbol cap, then debits
   * GOLD (idempotent on `casino-bet:{roundId}:{userId}:{clientBetId}` — a
   * PER-TAP key, not per-item, so stacking multiple bets on the same item
   * debits and persists once per tap) and persists a `PLACED` `CasinoBet`
   * row stamped with the debit's transaction id.
   *
   * A replay of the same `clientBetId` is a true no-op: the wallet debit
   * short-circuits to the original transaction (no second charge) and
   * `repo.createBet` returns the existing row (no duplicate) — so the
   * caller gets back the existing betId and the user's CURRENT balance.
   * A brand-new `clientBetId` on the same item debits again and creates a
   * second, stacked row.
   *
   * Throws `CasinoError` on any validation failure or insufficient balance —
   * the message reproduces the old app's exact text for that game.
   */
  async placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
    const { userId, game, roundId, item, amount, activeRoundId, phase, clientBetId } = input;
    const isLucky = game === CasinoGame.LUCKY_FRUIT;

    if (phase !== 'betting' || !activeRoundId || roundId !== activeRoundId) {
      throw new CasinoError('Betting is locked for this round');
    }
    if (!VALID_CHIPS.includes(amount)) {
      throw new CasinoError('Invalid chip/bet amount');
    }
    if (!this.bettable(game, item)) {
      throw new CasinoError(isLucky ? 'Invalid symbol' : 'Invalid item');
    }
    // Per-user lock so a user's own concurrent bet placements (e.g. rapid
    // double-submit) can't interleave their debit+persist critical sections.
    // Deliberately a DIFFERENT key than the wallet's own internal per-user
    // lock (acquired inside `wallet.debit` below) — reusing that key here
    // would deadlock (the same process trying to re-acquire a lock it
    // already holds against a non-reentrant SET NX).
    return this.locks.withLock(casinoBetLockKey(userId), async () => {
      if (isLucky) {
        const distinct = await this.repo.countDistinctSymbols(roundId, userId);
        if (distinct >= LUCKY_MAX_SYMBOLS) {
          // Cap only blocks a brand-new 7th symbol — adding more to a symbol
          // the user already bet on this round is always allowed.
          const already = await this.repo.hasSymbol(roundId, userId, item);
          if (!already) {
            throw new CasinoError('You can bet on a maximum of 6 symbols.');
          }
        }
      }

      let debit;
      try {
        debit = await this.wallet.debit({
          userId,
          currency: WalletCurrency.GOLD,
          amount,
          reason: WalletTxnReason.CASINO_BET,
          idempotencyKey: casinoBetIdempotencyKey(roundId, userId, clientBetId),
          referenceType: 'casino_round',
          referenceId: roundId,
          metadata: { gameCode: game, item },
        });
      } catch (err) {
        if (
          err instanceof BusinessException &&
          err.errorCode === ERROR_CODES.INSUFFICIENT_BALANCE
        ) {
          throw new CasinoError(isLucky ? 'Insufficient coins.' : 'Insufficient wallet balance');
        }
        throw err;
      }

      const bet = await this.repo.createBet({
        roundId,
        userId,
        game,
        betItem: item,
        betAmount: amount,
        clientBetId,
        betTxnId: debit.transactionId,
      });

      return { balanceAfter: debit.balanceAfter, betId: bet.id };
    });
  }

  private effectiveMultiplier(game: CasinoGame, betItem: string, winningOutcome: string): number {
    return game === CasinoGame.GREEDY_FOOD
      ? greedyEffectiveMultiplier(betItem, winningOutcome)
      : luckyEffectiveMultiplier(betItem, winningOutcome);
  }

  /**
   * Settles a round whose winning outcome has ALREADY been selected (see the
   * class doc comment — this method never re-selects it). One atomic
   * transaction, replicating `GamesService.settleResult`'s
   * lock-then-transaction pattern: every credited user's wallet lock is
   * acquired up front (sorted, to avoid deadlock — see `withWalletLocks`)
   * because passing `tx` into `wallet.credit` makes the movement join THIS
   * transaction instead of taking the wallet's own internal per-user lock.
   * Inside the transaction: fetch every still-`PLACED` bet for the round,
   * credit each WINNING bet its own stake × effective multiplier
   * (idempotent on `casino-win:{roundId}:{betId}` — see §5.5 of the design
   * doc), update every bet to `WON`/`LOST`, then close the round `SETTLED`
   * with the winning outcome. A user with multiple winning bets gets ONE
   * credit PER bet (each its own ledger row, exactly like the old app) but
   * the returned `payouts`/`winners` total is SUMMED across those bets —
   * fixing the old app's `winnersMap.set(...)` overwrite bug (see §7.4).
   *
   * Because `listPlacedBets` only ever returns bets still in `PLACED`
   * status, re-invoking `settleRound` for an already-settled round is a
   * cheap no-op (nothing left to credit) — no double-crediting even without
   * an explicit "already settled" guard.
   *
   * REFUND-ON-FAILURE: if the transaction throws (e.g. mid-settle crash),
   * every bet for the round is refunded its own stake instead (see
   * `refundRound`) and the round is closed `ABORTED`. This method then
   * RESOLVES (does not re-throw) with `aborted: true` and empty
   * `payouts`/`winners`, so a caller can tell "settled, nobody won" apart
   * from "settlement failed, refunded" — the old app crashed here silently.
   */
  async settleRound(
    game: CasinoGame,
    roundId: string,
    winningOutcome: string,
  ): Promise<SettleRoundResult> {
    const placed = await this.repo.listPlacedBets(roundId);
    const computed = placed.map((bet) => ({
      bet,
      payout: Number(bet.betAmount) * this.effectiveMultiplier(game, bet.betItem, winningOutcome),
    }));
    const creditedUserIds = computed.filter((c) => c.payout > 0).map((c) => c.bet.userId);

    const payouts: Record<string, number> = {};
    try {
      await this.withWalletLocks(creditedUserIds, () =>
        this.repo.runInTransaction(async (tx) => {
          for (const { bet, payout } of computed) {
            if (payout > 0) {
              const credit = await this.wallet.credit(
                {
                  userId: bet.userId,
                  currency: WalletCurrency.GOLD,
                  amount: payout,
                  reason: WalletTxnReason.CASINO_WIN,
                  idempotencyKey: casinoWinIdempotencyKey(roundId, bet.id),
                  referenceType: 'casino_round',
                  referenceId: roundId,
                  metadata: { gameCode: game, item: bet.betItem, outcome: winningOutcome },
                },
                tx,
              );
              await this.repo.updateBet(
                bet.id,
                {
                  status: CasinoBetStatus.WON,
                  payoutAmount: payout,
                  winTxnId: credit.transactionId,
                  settledAt: new Date(),
                },
                tx,
              );
              payouts[bet.userId] = (payouts[bet.userId] ?? 0) + payout;
            } else {
              await this.repo.updateBet(
                bet.id,
                { status: CasinoBetStatus.LOST, settledAt: new Date() },
                tx,
              );
            }
          }
          await this.repo.closeRound(roundId, CasinoRoundStatus.SETTLED, winningOutcome, tx);
        }),
      );
    } catch (err) {
      this.logger.error(
        `Casino settlement failed for round ${roundId} (${game}), outcome=${winningOutcome}: ` +
          `${(err as Error).message}. Refunding all placed bets.`,
      );
      await this.refundRound(game, roundId, placed);
      return { winningOutcome, payouts: {}, winners: [], aborted: true };
    }

    const winners = Object.entries(payouts)
      .map(([userId, amount]) => ({ userId, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, TOP_WINNERS);

    return { winningOutcome, payouts, winners };
  }

  /**
   * Refund-on-failure recovery. Deliberately NOT one all-or-nothing
   * transaction: the very failure that got us here may itself be a DB/
   * transaction problem, so each bet's refund is independent — one bad row
   * must never block the rest (mirrors `GamesService.refundParticipants`).
   * Idempotent on `casino-refund:{roundId}:{betId}` per bet, so re-running
   * this (e.g. a retried settlement) never double-refunds. The round is
   * always closed `ABORTED` at the end, even if some individual refund
   * failed (logged for manual reconciliation, never thrown).
   */
  private async refundRound(game: CasinoGame, roundId: string, placed: CasinoBet[]): Promise<void> {
    for (const bet of placed) {
      try {
        const credit = await this.wallet.credit({
          userId: bet.userId,
          currency: WalletCurrency.GOLD,
          amount: Number(bet.betAmount),
          reason: WalletTxnReason.CASINO_REFUND,
          idempotencyKey: casinoRefundIdempotencyKey(roundId, bet.id),
          referenceType: 'casino_round',
          referenceId: roundId,
          metadata: { gameCode: game, item: bet.betItem },
        });
        await this.repo.updateBet(bet.id, {
          status: CasinoBetStatus.REFUNDED,
          payoutAmount: Number(bet.betAmount),
          winTxnId: credit.transactionId,
          settledAt: new Date(),
        });
      } catch (err) {
        this.logger.error(
          `Casino refund failed for bet ${bet.id} (user ${bet.userId}, round ${roundId}): ` +
            `${(err as Error).message}`,
        );
      }
    }
    try {
      await this.repo.closeRound(roundId, CasinoRoundStatus.ABORTED, null);
    } catch (err) {
      this.logger.error(`Failed to close round ${roundId} as ABORTED: ${(err as Error).message}`);
    }
  }

  /**
   * A user's win history for one game — thin passthrough to
   * `CasinoRepository.winHistory`, capped at `WIN_HISTORY_LIMIT` (100, matching
   * the old app's `LIMIT 100` in `get_greedy_food_win_history`/
   * `get_lucky_fruit_win_history`). Win history has no dedicated table: it's
   * derived from `CasinoBet` rows with `status = WON`, newest first — see
   * §5.6 of the design doc. The gateway (a later task) emits the result
   * verbatim as `{ history }`.
   */
  async getWinHistory(userId: string, game: CasinoGame): Promise<CasinoWinHistoryEntry[]> {
    return this.repo.winHistory(userId, game, WIN_HISTORY_LIMIT);
  }

  /**
   * Acquire the wallet lock for each of `userIds` (deduped, sorted to avoid
   * deadlock against another caller locking the same set) before running
   * `fn` — mirrors `GamesService.withWalletLocks`. Needed wherever we pass a
   * shared `tx` into `wallet.credit`: that makes the movement join our
   * transaction instead of taking the wallet's own internal per-user lock,
   * so we take that same lock here for the whole transaction.
   */
  private async withWalletLocks<T>(userIds: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(userIds)].sort();
    const run = (i: number): Promise<T> =>
      i >= sorted.length ? fn() : this.locks.withLock(walletLockKey(sorted[i]), () => run(i + 1));
    return run(0);
  }
}
