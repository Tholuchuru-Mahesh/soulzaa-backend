import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, VideoRoomPkParticipant, VideoRoomPkSide, VideoRoomPkTeam } from '@prisma/client';
import type { DomainEvent } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { REDIS_CLIENT, type RedisClient } from 'src/infra/redis/redis.constants';
import { loadVideoRoomPkConfig } from '../config/video-room-pk.config';
import {
  PK_MULTIPLIER_BASE_BPS,
  pkEmitKey,
  pkScoreKey,
} from '../constants/video-room-pk.constants';
import { PkScoreUpdatedEvent, type PkTeamView } from '../events/video-room-pk.events';
import { PKScoreException } from '../exceptions/video-room-pk.exceptions';
import { Db, VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import type { PkScoringSnapshot } from './video-room-pk-score.engine';
import { VideoRoomPkScoreEngine } from './video-room-pk-score.engine';

export interface PkScoringInput {
  roomId: string;
  senderId: string;
  receiverIds: string[];
  totalCoinValue: number;
  giftTxnId: string;
  batchId?: string;
}

export interface PkScoringResult {
  battleId: string | null;
  applied: number;
  events: DomainEvent<unknown>[];
  /** Set only when at least one leg actually changed a score; null means "nothing to mirror". */
  mirror: { battleId: string; teams: PkTeamView[]; giftCount: number; baseTotal: number } | null;
}

/** Bounded CAS retries. Losing three times in one gift means extreme contention. */
const MAX_CAS_RETRIES = 3;

/** Scoreboard HASH lifetime, refreshed on every write. Long enough for a full battle. */
const PK_SCORE_TTL_SECONDS = 6 * 60 * 60;

function toTeamViews(teams: VideoRoomPkTeam[]): PkTeamView[] {
  return teams.map((t) => ({ teamId: t.id, side: t.side, score: Number(t.score) }));
}

/**
 * `battle.scoringSnapshot` reaches us via an unchecked JSON cast, so it can be
 * `null`, `{}`, or a legacy shape predating a snapshot schema change — none of
 * which `VideoRoomPkScoreEngine.resolve()` guards, since it dereferences
 * `snapshot.strategies` OUTSIDE its own per-strategy try/catch. Validate the
 * two fields `resolve()` actually touches and, if either is missing or the
 * wrong type, fall back to an empty-strategies snapshot at the 1.0× base
 * rate. A battle row predating the shape change must still score — just
 * without multipliers — rather than aborting the leg on a malformed cast.
 */
function toSafeSnapshot(raw: unknown): PkScoringSnapshot {
  const candidate = raw as Partial<PkScoringSnapshot> | null | undefined;
  if (candidate && Array.isArray(candidate.strategies) && typeof candidate.capBps === 'number') {
    return candidate as PkScoringSnapshot;
  }
  return {
    strategies: [],
    vipBonusBpsPerTier: 0,
    eventBonusBps: 0,
    capBps: PK_MULTIPLIER_BASE_BPS,
  };
}

/** One successfully-scored leg, carried from the participant loop to event construction. */
interface ScoredLeg {
  side: VideoRoomPkSide;
  participantId: string;
  userId: string;
  scoredAmount: bigint;
  multiplierBps: number;
}

/**
 * Raises PK score from inside the gift transaction (VR-12 spec §6).
 *
 * Postgres-only by contract: no Redis, no queue, no sockets here. The mirror and
 * the broadcast are deferred to postCommit, driven by what this returns — which
 * is why a PK failure can never roll back a paid gift, and why a rolled-back
 * gift can never leave score behind.
 *
 * Scoring is a LEDGER, not an escrow: nothing here debits or credits a wallet.
 */
@Injectable()
export class VideoRoomPkScoringService {
  private readonly logger = new Logger(VideoRoomPkScoringService.name);

  constructor(
    private readonly repo: VideoRoomPkRepository,
    private readonly engine: VideoRoomPkScoreEngine,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  async apply(tx: Prisma.TransactionClient, input: PkScoringInput): Promise<PkScoringResult> {
    const idle: PkScoringResult = { battleId: null, applied: 0, events: [], mirror: null };
    if (input.totalCoinValue <= 0 || input.receiverIds.length === 0) return idle;

    // Mirrors `reverse()`'s guard below: scoring is best-effort, never allowed
    // to propagate into the gift's own `$transaction`. The two unguarded paths
    // that motivate this are (a) `engine.resolve()` dereferencing
    // `snapshot.strategies` outside its own per-strategy try/catch when the
    // cast below is malformed, and (b) any repository call in the loop
    // rejecting. Note what this DOES NOT buy: if the rejection is a POSTGRES
    // error, Prisma/Postgres has already doomed this transaction, and
    // catching it here does not un-abort it — the gift is lost either way.
    // The real value is non-DB faults (a bad cast, an engine bug), where the
    // paid gift is otherwise still committable and swallowing here is what
    // lets it go through undisturbed.
    try {
      // Only a LIVE battle scores. COUNTDOWN and PAUSED are silent no-ops: the
      // gift still succeeds, it just does not count — a gift while the clock is
      // frozen would create score with no time running against it.
      const battle = await this.repo.findLive(input.roomId, tx);
      if (!battle) return idle;

      // Each receiver gets a WHOLE gift (gift.service.ts:196-200), so the per-leg
      // value is the exact quotient, never a remainder-bearing split.
      const perReceiver = Math.floor(input.totalCoinValue / input.receiverIds.length);
      if (perReceiver <= 0) return idle;

      const participants = await this.repo.findParticipantsByUserIds(
        battle.id,
        input.receiverIds,
        tx,
      );
      if (participants.length === 0) return idle;

      const snapshot = toSafeSnapshot(battle.scoringSnapshot);
      const legs: ScoredLeg[] = [];
      let applied = 0;

      for (const participant of participants) {
        const multiplierBps = await this.engine.resolve({
          roomId: input.roomId,
          battleId: battle.id,
          senderId: input.senderId,
          receiverId: participant.userId,
          baseAmount: perReceiver,
          snapshot,
          db: tx,
        });
        const base = BigInt(perReceiver);
        const scored = (base * BigInt(multiplierBps)) / BigInt(PK_MULTIPLIER_BASE_BPS);

        const team = await this.casTeam(tx, participant.teamId, scored);
        if (!team) continue; // contention beyond retries; the next gift carries it
        await this.casParticipant(tx, participant.id, scored);

        await this.repo.addContribution(
          {
            battleId: battle.id,
            roomId: input.roomId,
            teamId: participant.teamId,
            participantId: participant.id,
            side: participant.side,
            senderId: input.senderId,
            receiverId: participant.userId,
            baseAmount: base,
            multiplierBps,
            scoredAmount: scored,
            giftTxnId: input.giftTxnId,
            batchId: input.batchId ?? null,
          },
          tx,
        );

        applied += Number(scored);
        legs.push({
          side: participant.side,
          participantId: participant.id,
          userId: participant.userId,
          scoredAmount: scored,
          multiplierBps,
        });
      }

      const teams = await this.repo.listTeams(battle.id, tx);
      const teamViews = toTeamViews(teams);
      const events: DomainEvent<unknown>[] = legs.map(
        (leg) =>
          new PkScoreUpdatedEvent({
            roomId: input.roomId,
            battleId: battle.id,
            side: leg.side,
            teams: teamViews,
            participantId: leg.participantId,
            userId: leg.userId,
            scoredAmount: Number(leg.scoredAmount),
            multiplierBps: leg.multiplierBps,
          }),
      );

      const [giftCount, baseTotal] = await Promise.all([
        this.repo.countGifts(battle.id, tx),
        this.repo.sumBaseAmount(battle.id, tx),
      ]);

      return {
        battleId: battle.id,
        applied,
        events,
        mirror: { battleId: battle.id, teams: teamViews, giftCount, baseTotal: Number(baseTotal) },
      };
    } catch (err) {
      // Return the SAME inert shape as the no-live-battle fast path, never a
      // partially-populated result: legs scored before the throw may not have
      // committed, so nothing here should be handed to Task 14's postCommit as
      // settled score to mirror.
      this.logger.warn(`PK scoring failed for room ${input.roomId}: ${(err as Error).message}`);
      return idle;
    }
  }

  /**
   * Compensating negative contribution for a post-commit refund (VR-12 spec
   * §6.5). Resolves the battle from `roomId` via `findCurrent` — deliberately
   * NOT `findLive` — because a refund may legitimately arrive while the
   * battle is PAUSED or RECOVERING and the original score must still be
   * undone. `findCurrent` excludes every terminal status, which is exactly
   * what makes this a no-op against a COMPLETED battle: once rewards are
   * paid, retroactively rewriting the winner would be worse than the
   * inconsistency (the caller logs that case as an anomaly instead).
   *
   * Negates the EXACT amounts stored on the original ledger row(s) for this
   * `giftTxnId`, never a freshly recomputed multiplier. VIP tier or config
   * can drift between the original gift and its refund; recomputing here
   * would undo a different amount than was ever credited — the same class of
   * bug `addTeamScore`'s CAS contract exists to prevent on the credit side.
   *
   * Best-effort for setup reads and unexpected/transient faults (a rejected
   * repository call, a malformed row): those are logged and swallowed, same
   * as always — a refund must always succeed even if its PK compensation
   * cannot. The one exception is a genuine, known failure mode: if the TEAM
   * side of a compensation applies but the PARTICIPANT side then exhausts
   * its own CAS retries, the two are left inconsistent (the team score is
   * already adjusted; the participant's is not) for a battle that is still
   * non-terminal and can still be watched or settled — unlike the team-level
   * CAS exhaustion below (a clean, atomic no-op with nothing yet applied),
   * this one is surfaced as {@link PKScoreException} instead of silently
   * continuing. It still never escapes to the caller un-caught: the only
   * caller, `VideoRoomPkReversalListener`, already wraps its own
   * `$transaction` (which is what actually rolls back these partial writes)
   * in a catch that absorbs any error — so the refund itself is still never
   * put at risk.
   */
  async reverse(tx: Prisma.TransactionClient, input: PkScoringInput): Promise<void> {
    try {
      const battle = await this.repo.findCurrent(input.roomId, tx);
      if (!battle) return;

      const originals = await this.repo.findContributions(battle.id, input.giftTxnId, tx);
      if (originals.length === 0) return;

      for (const original of originals) {
        const negScored = -original.scoredAmount;

        const team = await this.casTeam(tx, original.teamId, negScored);
        if (!team) continue; // contention beyond retries; leave it for an operator

        const participant = await this.casParticipant(tx, original.participantId, negScored);
        if (!participant) {
          throw new PKScoreException(
            `PK compensation for battle ${battle.id} could not be applied to participant ` +
              `${original.participantId}: CAS contention exhausted after the team side already applied.`,
          );
        }

        await this.repo.addContribution(
          {
            battleId: battle.id,
            roomId: input.roomId,
            teamId: original.teamId,
            participantId: original.participantId,
            side: original.side,
            senderId: original.senderId,
            receiverId: original.receiverId,
            baseAmount: -original.baseAmount,
            multiplierBps: original.multiplierBps,
            scoredAmount: negScored,
            giftTxnId: `${original.giftTxnId}:reversal`,
            batchId: original.batchId,
          },
          tx,
        );
      }
    } catch (err) {
      if (err instanceof PKScoreException) throw err;
      this.logger.warn(`PK reversal failed for gift ${input.giftTxnId}: ${(err as Error).message}`);
    }
  }

  /**
   * Compare-and-set with bounded retry against `videoRoomPkTeam.score`.
   * Reads the CURRENT score itself (rather than trusting a value the caller
   * read earlier) so a second participant on the SAME team, scored later in
   * this very loop, always CAS's against the up-to-date total instead of a
   * stale snapshot taken before the first participant's update.
   */
  private async casTeam(tx: Db, teamId: string, delta: bigint): Promise<VideoRoomPkTeam | null> {
    let current = await this.repo.getTeam(teamId, tx);
    if (!current) return null;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const updated = await this.repo.addTeamScore(teamId, current.score, delta, tx);
      if (updated) return updated;
      const fresh = await this.repo.getTeam(teamId, tx);
      if (!fresh) return null;
      current = fresh;
    }
    this.logger.warn(`CAS contention exhausted on PK team ${teamId}`);
    return null;
  }

  /** Mirrors `casTeam` exactly, against `videoRoomPkParticipant`. */
  private async casParticipant(
    tx: Db,
    participantId: string,
    delta: bigint,
  ): Promise<VideoRoomPkParticipant | null> {
    let current = await this.repo.getParticipant(participantId, tx);
    if (!current) return null;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const updated = await this.repo.addParticipantScore(participantId, current.score, delta, tx);
      if (updated) return updated;
      const fresh = await this.repo.getParticipant(participantId, tx);
      if (!fresh) return null;
      current = fresh;
    }
    this.logger.warn(`CAS contention exhausted on PK participant ${participantId}`);
    return null;
  }

  /**
   * Mirrors committed score into Redis. Post-commit only — `m` is exactly
   * what `apply()` returned, computed entirely from Postgres reads taken
   * inside the gift's own transaction, so a caller can safely fire this
   * after commit without a second database round trip.
   *
   * Writes the scoreboard as a real Redis HASH (`{ RED, BLUE, giftCount,
   * baseTotal }`), not a JSON blob — the read side (Task 21) needs cheap
   * per-field reads, not a full deserialize for one number.
   */
  async mirror(m: NonNullable<PkScoringResult['mirror']>): Promise<void> {
    const key = pkScoreKey(m.battleId);
    const fields: Record<string, string> = {
      giftCount: String(m.giftCount),
      baseTotal: String(m.baseTotal),
    };
    for (const team of m.teams) fields[team.side] = String(team.score);
    await this.redis.hset(key, fields);
    await this.redis.expire(key, PK_SCORE_TTL_SECONDS);
  }

  /**
   * Throttle gate for `pkScoreUpdated`. A hot battle at 200 gifts/sec would
   * otherwise push 200 broadcasts/sec of a barely-changed number to every
   * connected socket.
   */
  async shouldEmit(battleId: string): Promise<boolean> {
    const perSecond = loadVideoRoomPkConfig(this.config).scoreEmitPerSecond;
    if (perSecond <= 0) return true;
    const key = pkEmitKey(battleId);
    const last = await this.cache.get<number>(key);
    const now = Date.now();
    if (last !== null && now - last < Math.floor(1000 / perSecond)) return false;
    await this.cache.set(key, now, 60);
    return true;
  }
}
