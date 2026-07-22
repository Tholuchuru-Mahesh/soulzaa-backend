import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BackpackItemSource,
  CosmeticRarity,
  CosmeticType,
  Prisma,
  VideoRoomPkBattle,
  VideoRoomPkParticipant,
  VideoRoomPkRewardKind,
  VideoRoomPkSide,
  VideoRoomPkStatus,
  VideoRoomPkTeam,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { isPkTerminal } from '../constants/video-room-pk.constants';
import {
  PkEndedEvent,
  PkRewardDistributedEvent,
  PkWinnerDeclaredEvent,
  type PkTeamView,
} from '../events/video-room-pk.events';
import { PKRewardException, PKWinnerException } from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkRewardRepository } from '../repositories/video-room-pk-reward.repository';
import { VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import type { IVideoRoomPkSettlementService, PkSettlementTrigger } from './video-room-pk.service';
import { VideoRoomPkStateService } from './video-room-pk-state.service';

/** Badge granted to every winning-side participant. Cached after the first `ensureCosmetic`. */
const VIDEO_PK_WINNER_BADGE_NAME = 'Video PK Champion';

/** Basis-points denominator: 10000 bps == 100%. */
const BPS_DENOMINATOR = 10_000;

/** Standalone so `toSafeRewardSnapshot` (a free function, not a method) can log a clamp. */
const rewardSnapshotLogger = new Logger('VideoRoomPkRewardSnapshot');

/** The `poolBps`/`winnerBps`/`participationBps`/`bonusBps` shape frozen onto `battle.rewardSnapshot` at invite time (Task 17). */
export interface PkRewardSnapshot {
  poolBps: number;
  winnerBps: number;
  participationBps: number;
  bonusBps: number;
}

/** What a caller (Task 17's `end()`, Task 20's recovery sweep, Task 21's timer job) gets back. */
export interface PkSettlementResult {
  /** false ⇒ this call was a replay; nothing was minted or paid on this pass. */
  settled: boolean;
  winningTeamId: string | null;
  isDraw: boolean;
  poolAmount: number;
  allocatedAmount: number;
}

/** One recipient actually paid on THIS pass (a fresh reward row, not a duplicate). */
interface GrantedReward {
  userId: string;
  kind: VideoRoomPkRewardKind;
  amount: bigint;
}

/**
 * Everything produced inside the settlement transaction that the
 * post-commit phase (badges, events) needs. `null` ⇒ the CAS lost the
 * settlement race — the transaction still committed (there was nothing to
 * roll back), but nothing was minted or paid on this pass.
 */
interface SettlementOutcome {
  completed: VideoRoomPkBattle;
  teams: VideoRoomPkTeam[];
  winningTeamId: string | null;
  isDraw: boolean;
  winners: VideoRoomPkParticipant[];
  sourceAmount: bigint;
  giftCount: number;
  poolAmount: bigint;
  allocatedAmount: bigint;
  granted: GrantedReward[];
}

/** Clamp a raw bps value into `[0, BPS_DENOMINATOR]`, discarding any fractional/non-finite noise. */
function clampBps(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(BPS_DENOMINATOR, Math.max(0, Math.trunc(value)));
}

/**
 * `battle.rewardSnapshot` reaches us via an unchecked JSON cast (mirrors
 * `VideoRoomPkScoringService.toSafeSnapshot`). A malformed or legacy shape
 * degrades to an all-zero snapshot — a pool of 0, nothing minted — rather
 * than throwing and blocking settlement outright.
 *
 * Defence in depth against a misconfigured env var on the money path:
 * `poolBps` is clamped to `[0, 10000]` on its own, and the three SPLIT bps
 * (winner/participation/bonus) are clamped individually and then, if their
 * sum still exceeds 10000, scaled down proportionally so the sum is exactly
 * 10000 — every kind absorbs its share of the correction instead of one
 * being arbitrarily zeroed. Because `allocated` is computed as
 * `poolAmount * bps / 10000` for each kind, a sum <= 10000 is what keeps
 * `allocated <= poolAmount` true by construction.
 */
function toSafeRewardSnapshot(raw: unknown): PkRewardSnapshot {
  const candidate = raw as Partial<PkRewardSnapshot> | null | undefined;
  const poolBps = clampBps(typeof candidate?.poolBps === 'number' ? candidate.poolBps : 0);
  let winnerBps = clampBps(typeof candidate?.winnerBps === 'number' ? candidate.winnerBps : 0);
  let participationBps = clampBps(
    typeof candidate?.participationBps === 'number' ? candidate.participationBps : 0,
  );
  let bonusBps = clampBps(typeof candidate?.bonusBps === 'number' ? candidate.bonusBps : 0);

  const splitSum = winnerBps + participationBps + bonusBps;
  if (splitSum > BPS_DENOMINATOR) {
    rewardSnapshotLogger.warn(
      `PK reward snapshot split bps sum ${splitSum} exceeds ${BPS_DENOMINATOR}; scaling ` +
        `winner/participation/bonus down proportionally so allocated cannot exceed the pool`,
    );
    winnerBps = Math.floor((winnerBps * BPS_DENOMINATOR) / splitSum);
    participationBps = Math.floor((participationBps * BPS_DENOMINATOR) / splitSum);
    bonusBps = Math.floor((bonusBps * BPS_DENOMINATOR) / splitSum);
  }

  return { poolBps, winnerBps, participationBps, bonusBps };
}

/**
 * VR-12 Task 18: the money path. Winner computation, reward-pool minting and
 * wallet distribution for a PK battle — the class Task 24 registers under
 * {@link VIDEO_ROOM_PK_SETTLEMENT} (defined in `video-room-pk.service.ts`).
 *
 * Safe to call any number of times for the same battle — BullMQ retries and
 * the recovery sweep both call it, and a crash mid-distribution resumes
 * correctly rather than double-paying. Three independent guards, each
 * cheaper than the last to lose a race on:
 *
 * 1. The CAS transition (`state.tryTransition`) — whoever flips
 *    LIVE|PAUSED → COMPLETED owns the settlement. Everyone else exits
 *    quietly with `settled: false`; a replayed end-job finding a completed
 *    battle is the normal case, not a warning.
 * 2. The reward pool's `battleId @unique` — a replayed settlement that DID
 *    win the CAS (e.g. a crash right after it) still cannot mint twice.
 * 3. Each reward row's `(battleId, userId, kind) @unique` — a replayed
 *    distribution pays each recipient-kind exactly once, independently of
 *    the wallet's own `idempotencyKey`.
 *
 * The pool is sized on BASE contribution (`repo.sumBaseAmount`), never
 * scored: a VIP multiplier decides who wins, it must never decide how much
 * money exists. Draw battles mint no winner slice — not redistributed,
 * simply not minted — and integer-division dust is left unminted rather
 * than handed to an arbitrary recipient.
 *
 * The CAS itself (guard 1 above) runs as the FIRST statement inside that
 * same transaction, not before it: the transition to COMPLETED and the
 * payout it authorizes must commit or roll back together. A crash between
 * a standalone CAS commit and a separate payout transaction would leave the
 * battle permanently COMPLETED with no pool and no reward rows — every
 * retry's `isPkTerminal` fast-check above would then exit quietly forever,
 * because the battle is (wrongly) terminal. Winner computation, pool
 * sizing, reward rows and wallet credits all run on that one transaction
 * client. Badge grants and event publishing happen strictly AFTER it
 * commits: a rolled-back settlement (e.g. a wallet rejection or a crash
 * mid-distribution) must not leave a granted badge or a broadcast winner
 * behind, and — since the CAS is now part of that same rollback — must not
 * leave the battle COMPLETED either.
 *
 * Two structural-integrity checks can throw ({@link PKWinnerException} when
 * a battle somehow has no teams to rank; {@link PKRewardException} when a
 * non-draw winner slice has money but no winning participant to pay it to).
 * Both are defensive guards against a state `invite()` should make
 * impossible, not expected operational paths: they roll back this same
 * transaction (nothing committed, nothing partially paid) and propagate to
 * the caller — `end()` surfaces them as a failed request, the recovery
 * sweep logs and moves on to the next battle in its batch, exactly like any
 * other settlement failure.
 */
@Injectable()
export class VideoRoomPkSettlementService implements IVideoRoomPkSettlementService {
  private readonly logger = new Logger(VideoRoomPkSettlementService.name);
  private badgeCosmeticId: string | null = null;

  constructor(
    private readonly repo: VideoRoomPkRepository,
    private readonly rewards: VideoRoomPkRewardRepository,
    private readonly state: VideoRoomPkStateService,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async settle(
    battleId: string,
    trigger: PkSettlementTrigger,
  ): Promise<VideoRoomPkBattle & PkSettlementResult> {
    const battle = await this.repo.getBattle(battleId);
    if (!battle || isPkTerminal(battle.status)) {
      this.logger.debug(
        `PK settlement no-op for battle ${battleId} — already terminal (trigger: ${trigger})`,
      );
      return this.notSettled(battle);
    }

    // ---- The CAS and the ENTIRE payout it authorizes run inside ONE
    // transaction. The transition to COMPLETED is the FIRST statement
    // inside `tx`, not a standalone pre-transaction commit: if anything
    // below it throws (a wallet rejection, a crash), the whole transaction
    // — CAS included — rolls back, so the battle is never left COMPLETED
    // with no pool and no reward rows. A `null` outcome means the CAS lost
    // the race (a normal replay under BullMQ retries / the recovery sweep,
    // not an error) and nothing in this transaction needed to commit. ----
    const outcome = await this.repo.runInTransaction<SettlementOutcome | null>(async (tx) => {
      // The whole replay story: whoever flips LIVE|PAUSED → COMPLETED owns
      // settlement.
      const completed = await this.state.tryTransition(
        battleId,
        battle.status,
        VideoRoomPkStatus.COMPLETED,
        { completedAt: new Date() },
        tx,
      );
      if (!completed) return null;

      // ---- Winner computation. Read AFTER the CAS wins, on the SAME `tx`:
      // status is already COMPLETED within this transaction, so
      // VideoRoomPkScoringService.apply()'s `findLive` guard stops any
      // further gift from moving these scores underneath us once this
      // transaction commits. ----
      const teams = await this.repo.listTeams(battleId, tx);
      if (teams.length === 0) {
        // Every battle is created with exactly RED and BLUE teams in the
        // same transaction as the battle row itself (VideoRoomPkService.invite)
        // — this should be structurally impossible. It is still checked
        // because ranked[0] below is otherwise silently `undefined`, which
        // would settle a battle with a null winner and no diagnostic. This
        // throw rolls back the whole transaction (the CAS to COMPLETED
        // included), leaving the battle exactly as it was for a human to
        // investigate rather than quietly completing with a corrupt result.
        throw new PKWinnerException(
          `Cannot determine a PK winner for battle ${battleId}: it has no teams.`,
        );
      }
      const ranked = [...teams].sort((a, b) => Number(b.score - a.score));
      const isDraw = ranked.length > 1 && ranked[0].score === ranked[1].score;
      const winningTeam = isDraw ? null : (ranked[0] ?? null);
      const winningTeamId = winningTeam?.id ?? null;

      const participants = await this.repo.listParticipants(battleId, tx);
      const winners = winningTeam ? participants.filter((p) => p.teamId === winningTeam.id) : [];

      // ---- Pool sizing: BASE contribution ONLY, bps from the FROZEN
      // snapshot — never live config, never `scoredAmount`. Sizing on scored
      // amount would let a 3x VIP multiplier triple the platform's liability
      // for coins nobody spent. ----
      const [sourceAmount, giftCount, topContributor] = await Promise.all([
        this.repo.sumBaseAmount(battleId, tx),
        this.repo.countGifts(battleId, tx),
        this.repo.topContributor(battleId, tx),
      ]);
      const snapshot = toSafeRewardSnapshot(completed.rewardSnapshot);
      const poolAmount = (sourceAmount * BigInt(snapshot.poolBps)) / 10_000n;
      // A draw mints no winner slice — not redistributed, simply not minted.
      const winnerShare = isDraw ? 0n : (poolAmount * BigInt(snapshot.winnerBps)) / 10_000n;
      const participationShare = (poolAmount * BigInt(snapshot.participationBps)) / 10_000n;
      const bonusShare = (poolAmount * BigInt(snapshot.bonusBps)) / 10_000n;

      // ---- Distribution: pool + winner-field patch + reward rows + wallet
      // credits, all on this same transaction client. ----
      const { pool } = await this.rewards.createPool(
        {
          battleId,
          roomId: completed.roomId,
          sourceAmount,
          poolAmount,
          winnerBps: snapshot.winnerBps,
          participationBps: snapshot.participationBps,
          bonusBps: snapshot.bonusBps,
        },
        tx,
      );

      // Persist the winner fields onto the battle row. COMPLETED → COMPLETED
      // is not a declared FSM edge (state.transition would reject it), but
      // the repository's conditional UPDATE is a generic status-scoped
      // primitive, not an FSM check — reusing it here avoids a second,
      // near-identical repo method for what is really just a data patch on
      // the terminal row this same settlement pass just created.
      await this.repo.transition(
        battleId,
        VideoRoomPkStatus.COMPLETED,
        VideoRoomPkStatus.COMPLETED,
        { winningTeamId, isDraw },
        tx,
      );

      // A non-draw settlement with money earmarked for the winner slice
      // (`winnerShare > 0n`) MUST have a non-zero winner count to pay it to —
      // `winningTeam` is only non-null when `invite()`'s own RED/BLUE
      // participant arrays were non-empty (DTO-level `@ArrayNotEmpty`), so
      // this is another structural-impossibility guard, not a real-world
      // path. Left unguarded, the branch below would simply skip the whole
      // winner slice: money the pool already reserved would vanish silently
      // (never allocated, never paid, never logged) instead of surfacing as
      // the reward-distribution failure it actually is.
      if (winningTeam && winnerShare > 0n && winners.length === 0) {
        throw new PKRewardException(
          `Cannot distribute the PK winner reward for battle ${battleId}: ` +
            `winning team ${winningTeam.id} has no participants.`,
        );
      }

      const granted: GrantedReward[] = [];
      let allocated = 0n;

      if (winners.length > 0 && winnerShare > 0n) {
        const perWinner = winnerShare / BigInt(winners.length);
        if (perWinner > 0n) {
          for (const w of winners) {
            const paid = await this.payOne(
              tx,
              battleId,
              completed.roomId,
              { userId: w.userId, teamId: w.teamId, side: w.side },
              VideoRoomPkRewardKind.WINNER,
              perWinner,
            );
            if (paid) {
              allocated += perWinner;
              granted.push(paid);
            }
          }
        }
      }

      if (participants.length > 0 && participationShare > 0n) {
        const perParticipant = participationShare / BigInt(participants.length);
        if (perParticipant > 0n) {
          for (const p of participants) {
            const paid = await this.payOne(
              tx,
              battleId,
              completed.roomId,
              { userId: p.userId, teamId: p.teamId, side: p.side },
              VideoRoomPkRewardKind.PARTICIPATION,
              perParticipant,
            );
            if (paid) {
              allocated += perParticipant;
              granted.push(paid);
            }
          }
        }
      }

      if (topContributor && bonusShare > 0n) {
        const paid = await this.payOne(
          tx,
          battleId,
          completed.roomId,
          { userId: topContributor.userId, teamId: null, side: null },
          VideoRoomPkRewardKind.BONUS,
          bonusShare,
        );
        if (paid) {
          allocated += bonusShare;
          granted.push(paid);
        }
      }

      if (allocated > 0n) await this.rewards.addAllocated(pool.id, allocated, tx);

      return {
        completed,
        teams,
        winningTeamId,
        isDraw,
        winners,
        sourceAmount,
        giftCount,
        poolAmount,
        allocatedAmount: allocated,
        granted,
      };
    });

    if (!outcome) {
      this.logger.debug(
        `PK settlement no-op for battle ${battleId} — lost the settlement race (trigger: ${trigger})`,
      );
      return this.notSettled(battle);
    }

    const {
      completed,
      teams,
      winningTeamId,
      isDraw,
      winners,
      sourceAmount,
      giftCount,
      poolAmount,
      allocatedAmount,
      granted,
    } = outcome;

    // ---- Badge grants (post-commit only). A rolled-back transaction must
    // never leave a granted badge behind. ----
    const winnerGrants = granted.filter((g) => g.kind === VideoRoomPkRewardKind.WINNER);
    if (winnerGrants.length > 0) {
      const badgeId = await this.winnerBadgeId();
      for (const g of winnerGrants) {
        await this.cosmetics.grantToUser({
          userId: g.userId,
          cosmeticId: badgeId,
          source: BackpackItemSource.EVENT,
          // Prefixed `video-pk:` — `grantKey` is a GLOBAL idempotency key in
          // the cosmetics module, and the audio engine already uses the bare
          // `pk:{battleId}:{userId}` form. The prefix makes a namespace
          // collision structurally impossible rather than merely improbable.
          grantKey: `video-pk:${battleId}:${g.userId}`,
        });
      }
    }

    // ---- Events (post-commit only), in order: ENDED, WINNER_DECLARED,
    // REWARD_DISTRIBUTED. ----
    const teamViews: PkTeamView[] = teams.map((t) => ({
      teamId: t.id,
      side: t.side,
      score: Number(t.score),
    }));
    await this.bus.publish(
      new PkEndedEvent({
        roomId: completed.roomId,
        battleId,
        winningTeamId,
        isDraw,
        teams: teamViews,
        durationSeconds: completed.durationSeconds,
        giftCount,
        totalBase: Number(sourceAmount),
      }),
    );
    await this.bus.publish(
      new PkWinnerDeclaredEvent({
        roomId: completed.roomId,
        battleId,
        winningTeamId,
        isDraw,
        winners: winners.map((w) => w.userId),
      }),
    );
    await this.bus.publish(
      new PkRewardDistributedEvent({
        roomId: completed.roomId,
        battleId,
        poolAmount: Number(poolAmount),
        allocatedAmount: Number(allocatedAmount),
        rewards: granted.map((g) => ({ userId: g.userId, kind: g.kind, amount: Number(g.amount) })),
      }),
    );

    return {
      ...completed,
      winningTeamId,
      isDraw,
      settled: true,
      poolAmount: Number(poolAmount),
      allocatedAmount: Number(allocatedAmount),
    };
  }

  /**
   * Create-then-credit, in that order, so a duplicate reward row (our own
   * unique constraint) skips the wallet credit entirely rather than relying
   * on the wallet's idempotency alone to catch the replay. Two independent
   * guards for the same money.
   */
  private async payOne(
    tx: Prisma.TransactionClient,
    battleId: string,
    roomId: string,
    recipient: { userId: string; teamId: string | null; side: VideoRoomPkSide | null },
    kind: VideoRoomPkRewardKind,
    amount: bigint,
  ): Promise<GrantedReward | null> {
    const idempotencyKey = `pk:${battleId}:${recipient.userId}:${kind}`;
    const reward = await this.rewards.createReward(
      {
        battleId,
        roomId,
        userId: recipient.userId,
        teamId: recipient.teamId,
        side: recipient.side,
        kind,
        amount,
        currency: WalletCurrency.GOLD,
        idempotencyKey,
      },
      tx,
    );
    // null ⇒ this (battle, user, kind) was already paid on a prior pass.
    if (!reward) return null;

    const credited = await this.wallet.credit(
      {
        userId: recipient.userId,
        currency: WalletCurrency.GOLD,
        amount: Number(amount),
        reason: WalletTxnReason.PK_REWARD,
        idempotencyKey,
        referenceType: 'video_room_pk_reward',
        referenceId: reward.id,
      },
      tx,
    );

    // Backfill the link now that we have it. Not a second money-guard — the
    // reward row and the wallet movement are already tied by
    // `idempotencyKey` — just closes a permanently-null column that would
    // otherwise trap anyone querying `walletTxnId` directly.
    await this.rewards.setWalletTxnId(reward.id, credited.transactionId, tx);

    return { userId: recipient.userId, kind, amount };
  }

  /** Lazily resolved and cached, mirroring the audio PK engine's `winnerBadgeId()`. */
  private async winnerBadgeId(): Promise<string> {
    if (!this.badgeCosmeticId) {
      this.badgeCosmeticId = await this.cosmetics.ensureCosmetic({
        type: CosmeticType.BADGE,
        name: VIDEO_PK_WINNER_BADGE_NAME,
        rarity: CosmeticRarity.EPIC,
      });
    }
    return this.badgeCosmeticId;
  }

  private notSettled(battle: VideoRoomPkBattle | null): VideoRoomPkBattle & PkSettlementResult {
    return {
      ...(battle as VideoRoomPkBattle),
      settled: false,
      winningTeamId: battle?.winningTeamId ?? null,
      isDraw: battle?.isDraw ?? false,
      poolAmount: 0,
      allocatedAmount: 0,
    };
  }
}
