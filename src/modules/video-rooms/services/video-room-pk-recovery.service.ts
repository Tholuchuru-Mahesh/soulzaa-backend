import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomPkBattle, VideoRoomPkStatus, VideoRoomStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomPkConfig, type VideoRoomPkConfig } from '../config/video-room-pk.config';
import { isPkTerminal, PK_RECOVERY_LOCK_KEY } from '../constants/video-room-pk.constants';
import { PkRecoveredEvent } from '../events/video-room-pk.events';
import {
  BattleRecoveryException,
  PKRewardException,
  PKWinnerException,
} from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkInvitationRepository } from '../repositories/video-room-pk-invitation.repository';
import { VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import { VideoRoomPkInvitationService } from './video-room-pk-invitation.service';
import { VideoRoomPkSettlementService } from './video-room-pk-settlement.service';
import { VideoRoomPkStateService } from './video-room-pk-state.service';
import { VideoRoomPkTimerService } from './video-room-pk-timer.service';

/** Every non-terminal status — the fleet-wide "still needs watching" set. */
const PK_ACTIVE_STATUSES: readonly VideoRoomPkStatus[] = Object.values(VideoRoomPkStatus).filter(
  (s) => !isPkTerminal(s),
);

/**
 * `PK_ACTIVE_STATUSES` minus PAUSED and RECOVERING — the set condition 1
 * (`sweepExpiredBattles`) actually re-settles on a stale `endsAt`.
 *
 * PAUSED and RECOVERING freeze the clock by definition (`pause()`/
 * `handleHostDrop` deliberately leave `endsAt` untouched, so a resume can
 * restore the exact remaining time), so `endsAt <= now` is not a meaningful
 * "expired" signal for either — it is just whatever `endsAt` happened to be
 * before the freeze. Re-settling on it would auto-complete and pay out a
 * battle that still has real time left once resumed (a PAUSED battle with
 * 30s left, resumed 2 minutes later, must still have those 30s to play out).
 * RECOVERING's own deadline is `pausedAt + orphanTimeoutSeconds`, covered
 * separately by `sweepOrphans` (condition 4); PAUSED has no automatic
 * timeout at all — only an operator's own `resume()`/`cancel()` moves it.
 */
const PK_STALE_SETTLE_STATUSES: readonly VideoRoomPkStatus[] = PK_ACTIVE_STATUSES.filter(
  (s) => s !== VideoRoomPkStatus.PAUSED && s !== VideoRoomPkStatus.RECOVERING,
);

/**
 * Every status strictly before LIVE — none of these has an `endsAt` (that is
 * only ever set by `start()`'s ACCEPTED → COUNTDOWN transition), so none of
 * them can ever match `findStale`'s `endsAt <= now` filter. Condition 6
 * (`sweepStrandedPreLive`) is their only backstop.
 */
const PK_PRE_LIVE_STATUSES: readonly VideoRoomPkStatus[] = [
  VideoRoomPkStatus.CREATED,
  VideoRoomPkStatus.INVITED,
  VideoRoomPkStatus.PENDING,
  VideoRoomPkStatus.ACCEPTED,
];

/**
 * The PK-specific Prometheus gauges Task 23 will add to `VideoRoomsMetrics`.
 * Duck-typed here rather than added to that class (out of scope for this
 * task, and metrics/barrel edits are Tasks 23/24's) — `?.()` makes today's
 * call a no-op until they exist, and a real wire-up the moment they land,
 * with no further change needed in this file.
 */
interface PkRecoveryMetricsPort {
  setPkActive?(count: number): void;
  setPkRecoveryQueueDepth?(count: number): void;
}

/**
 * VR-12 Task 20: the backstop that reconciles PK battles whose timer job
 * never ran, plus host-disconnect handling.
 *
 * Every command in `VideoRoomPkService`/`VideoRoomPkJobsService` assumes its
 * own BullMQ job or caller runs to completion. It usually does. When it
 * doesn't — a worker crash between a CAS commit and the job it should have
 * scheduled, a Redis blip that drops a scheduled job, a host's socket dying
 * mid-battle, or a crash before a battle ever reaches LIVE — nothing else
 * ever revisits that battle. This sweep is what does: six conditions, each
 * independently guarded so one poisoned battle cannot block the other five,
 * checked on a timer no faster than `monitorIntervalSeconds` and capped at
 * `maxPerSweep` so a large backlog degrades gracefully instead of stalling a
 * tick.
 *
 * Settlement itself (`VideoRoomPkSettlementService.settle`) is idempotent —
 * CAS on the transition to COMPLETED, unique constraints on the pool and
 * every reward row — so re-settling a battle the sweep has already fixed, or
 * that a BullMQ retry is settling concurrently, is always safe to attempt.
 * Every settle/transition call below is wrapped per-battle so a single bad
 * row logs a warning and yields the rest of that condition's batch, exactly
 * like `VideoRoomTreasureRecoveryService.sweep`'s per-box guard.
 */
@Injectable()
export class VideoRoomPkRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomPkRecoveryService.name);
  private timer?: NodeJS.Timeout;
  /** Same-pod re-entrancy guard: the fleet lock's TTL can outlive a slow sweep. */
  private inFlight = false;

  constructor(
    private readonly repo: VideoRoomPkRepository,
    private readonly invitationRepo: VideoRoomPkInvitationRepository,
    private readonly invitations: VideoRoomPkInvitationService,
    private readonly state: VideoRoomPkStateService,
    private readonly timerService: VideoRoomPkTimerService,
    private readonly settlement: VideoRoomPkSettlementService,
    private readonly rooms: VideoRoomsRepository,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
    private readonly metrics: VideoRoomsMetrics,
    // `@Optional()`: `Function` has no injectable provider anywhere in the
    // graph, so a strict Nest DI resolution of this constructor — which unit
    // specs never exercise, since they all call `new VideoRoomPkRecoveryService(...)`
    // directly — throws `UnknownDependenciesException` without it. Nest then
    // supplies `undefined`, and JS's own default-parameter semantics apply
    // `() => Date.now()` to an `undefined` argument exactly as they would to
    // an omitted one, so real production wiring is unaffected either way.
    @Optional()
    private readonly now: () => number = () => Date.now(),
  ) {}

  onModuleInit(): void {
    const cfg = loadVideoRoomPkConfig(this.config);
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        this.logger.warn(`PK recovery tick failed: ${(err as Error).message}`),
      );
    }, cfg.monitorIntervalSeconds * 1000);
    // Never hold the event loop open for a background sweep.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * The tick ALWAYS runs; only the recovery ACTIONS are config-gated.
   *
   * VR-11 learned this the hard way: gating the timer itself on
   * `recoveryEnabled` (default false) left the queue-depth gauge reporting
   * zero forever in the default configuration — worse than having no metric,
   * because a zero reads as "healthy". Observability is not opt-in;
   * automatic repair is.
   *
   * `inFlight` guards a hazard the fleet lock alone does not cover: the lock
   * is acquired with a TTL of `monitorIntervalSeconds`, so a sweep that runs
   * LONGER than that interval can have its own lock expire before it
   * finishes — at which point this SAME pod's next timer fire would acquire
   * it again and run a second sweep concurrently with the first. The
   * distributed lock serialises across pods; this flag serialises within one.
   */
  async tick(): Promise<void> {
    const cfg = loadVideoRoomPkConfig(this.config);
    const now = new Date(this.now());
    await this.recordGauges(cfg, now);
    if (!cfg.recoveryEnabled) return;
    if (this.inFlight) return; // a sweep from THIS pod is still running

    this.inFlight = true;
    try {
      const release = await this.locks.acquire(
        PK_RECOVERY_LOCK_KEY,
        cfg.monitorIntervalSeconds * 1000,
      );
      if (!release) return; // another pod owns this sweep
      try {
        await this.guardSweep('sweepExpiredBattles', () => this.sweepExpiredBattles(cfg, now));
        await this.guardSweep('sweepCountdowns', () => this.sweepCountdowns(cfg, now));
        await this.guardSweep('sweepInvitations', () => this.sweepInvitations(cfg, now));
        await this.guardSweep('sweepOrphans', () => this.sweepOrphans(cfg, now));
        await this.guardSweep('sweepDeadRooms', () => this.sweepDeadRooms(cfg));
        await this.guardSweep('sweepStrandedPreLive', () => this.sweepStrandedPreLive(cfg, now));
      } finally {
        await release();
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Runs `fn`, logging and swallowing a failure rather than propagating it.
   * Each of the six conditions is an independent unit of recovery work; one
   * throwing (a DB blip on ITS OWN query, not just a single bad row within
   * it) must not prevent the other five from running this tick.
   */
  private async guardSweep(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`PK recovery sweep step "${label}" failed: ${(err as Error).message}`);
    }
  }

  /**
   * Observability only — never gated, never throws out. Reads the same two
   * backlogs the gated sweeps below would act on (stale battles, expired
   * invitations) so the gauge is a true "how much work is waiting" signal
   * even while `recoveryEnabled` is false and nothing is being repaired.
   */
  private async recordGauges(cfg: VideoRoomPkConfig, now: Date): Promise<void> {
    try {
      const [staleBattles, expiredInvitations] = await Promise.all([
        this.repo.findStale(now, [...PK_ACTIVE_STATUSES], cfg.maxPerSweep),
        this.invitationRepo.findExpired(now, cfg.maxPerSweep),
      ]);
      const metrics = this.metrics as unknown as PkRecoveryMetricsPort;
      metrics.setPkActive?.(staleBattles.length);
      metrics.setPkRecoveryQueueDepth?.(staleBattles.length + expiredInvitations.length);
    } catch (err) {
      this.logger.warn(`PK recovery gauge read failed: ${(err as Error).message}`);
    }
  }

  /**
   * Condition 1: any non-terminal battle whose `endsAt` has already passed —
   * the classic missed-end-job case. `settle` is idempotent (CAS + unique
   * constraints), so calling it on a status it cannot actually complete from
   * (e.g. a still-COUNTDOWN battle whose full window elapsed) is a harmless,
   * logged no-op; `sweepCountdowns` below is what promotes that battle so a
   * later tick can settle it for real.
   *
   * A `PKWinnerException`/`PKRewardException` out of `settle` is different in
   * kind from a transient DB fault: it means the battle's own data is broken
   * (no teams, or a winning team with nobody to pay) in a way no amount of
   * retrying will fix. That is surfaced as {@link BattleRecoveryException}
   * instead of logged-and-continued like every other failure here — the
   * throw still cannot escape this tick: `guardSweep` (the caller) absorbs
   * it exactly like it would any other error, so the remaining four sweep
   * conditions still run this tick. Only the rest of THIS condition's own
   * batch is skipped for the current tick; the next tick's `findStale` will
   * pick the still-unresolved battles back up.
   *
   * Deliberately queries `PK_STALE_SETTLE_STATUSES`, NOT `PK_ACTIVE_STATUSES`:
   * PAUSED and RECOVERING have a frozen clock, so their `endsAt` is stale by
   * construction, not expired — see that constant's doc.
   */
  private async sweepExpiredBattles(cfg: VideoRoomPkConfig, now: Date): Promise<void> {
    const stale = await this.repo.findStale(now, [...PK_STALE_SETTLE_STATUSES], cfg.maxPerSweep);
    for (const battle of stale) {
      try {
        await this.settlement.settle(battle.id, 'recovery');
      } catch (err) {
        if (err instanceof PKWinnerException || err instanceof PKRewardException) {
          throw new BattleRecoveryException(
            `PK battle ${battle.id} cannot be recovered: ${(err as Error).message}`,
          );
        }
        this.logger.warn(
          `Recovery sweep failed to settle stale PK battle ${battle.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Condition 2: a COUNTDOWN battle whose countdown deadline
   * (`startedAt + countdownSeconds`) has passed without the `video-room.pk.start`
   * job ever flipping it to LIVE. Mirrors `VideoRoomPkJobsService.handleStart`
   * exactly — transition, then arm the end timer against the (unchanged)
   * `endsAt` — because that job may simply never have existed (a crash
   * between `start()`'s commit and the job actually landing in the queue).
   */
  private async sweepCountdowns(cfg: VideoRoomPkConfig, now: Date): Promise<void> {
    const countdowns = await this.repo.findByStatus(VideoRoomPkStatus.COUNTDOWN, cfg.maxPerSweep);
    for (const battle of countdowns) {
      const deadline = battle.startedAt
        ? battle.startedAt.getTime() + battle.countdownSeconds * 1000
        : null;
      if (deadline === null || deadline > now.getTime()) continue;

      try {
        const live = await this.state.tryTransition(
          battle.id,
          VideoRoomPkStatus.COUNTDOWN,
          VideoRoomPkStatus.LIVE,
          {},
        );
        if (live) await this.timerService.scheduleEnd(live, now);
      } catch (err) {
        this.logger.warn(
          `Recovery sweep failed to advance stalled COUNTDOWN battle ${battle.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Condition 3: invitations past their TTL. `VideoRoomPkInvitationService
   * .expireDue` (Task 16) already owns the full rule — expire every past-TTL
   * SENT/DELIVERED row, then cancel the battle if nothing actionable remains
   * — so the sweep's only job is to invoke it with the sweep's own clock and
   * cap.
   */
  private async sweepInvitations(cfg: VideoRoomPkConfig, now: Date): Promise<void> {
    await this.invitations.expireDue(now, cfg.maxPerSweep);
  }

  /**
   * Condition 4: a RECOVERING battle older than `orphanTimeoutSeconds`. The
   * host never came back inside `recoveryGraceSeconds` (see
   * `handleHostReturn`), so there is nothing left to wait for — settle with
   * whatever scores stand. `pausedAt` is the SAME field a host-drop stamps
   * (see class doc on `handleHostDrop`), so this is the exact deadline the
   * grace window was measured against.
   */
  private async sweepOrphans(cfg: VideoRoomPkConfig, now: Date): Promise<void> {
    const recovering = await this.repo.findByStatus(VideoRoomPkStatus.RECOVERING, cfg.maxPerSweep);
    const cutoffMs = cfg.orphanTimeoutSeconds * 1000;
    for (const battle of recovering) {
      if (!battle.pausedAt || now.getTime() - battle.pausedAt.getTime() < cutoffMs) continue;
      try {
        await this.settlement.settle(battle.id, 'recovery');
      } catch (err) {
        this.logger.warn(
          `Recovery sweep failed to settle orphaned RECOVERING battle ${battle.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Condition 5: a LIVE battle whose room is no longer LIVE. A room can go
   * OFFLINE/ENDED out from under an in-progress battle (the owner ended the
   * room directly, a room-level recovery sweep elsewhere reclaimed it); this
   * battle has no other trigger that would ever notice, so it must be
   * checked here.
   */
  private async sweepDeadRooms(cfg: VideoRoomPkConfig): Promise<void> {
    const live = await this.repo.findByStatus(VideoRoomPkStatus.LIVE, cfg.maxPerSweep);
    for (const battle of live) {
      try {
        const room = await this.rooms.findById(battle.roomId);
        if (room && room.status === VideoRoomStatus.LIVE) continue;
        await this.settlement.settle(battle.id, 'recovery');
      } catch (err) {
        this.logger.warn(
          `Recovery sweep failed to settle PK battle ${battle.id} in a dead room: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Condition 6: a battle stranded in a pre-LIVE status — CREATED (a crash
   * between `invite()`'s commit and the INVITED transition, so no
   * invitation rows exist yet for `sweepInvitations` to ever notice),
   * INVITED/PENDING (invitations never resolved, or never created at all),
   * or ACCEPTED (every invitee accepted but nobody ever called `start()`) —
   * whose `createdAt` is older than `orphanTimeoutSeconds`.
   *
   * None of these states carries an `endsAt` (only `start()` sets it), so
   * condition 1 can never see them, and the DB's partial unique index
   * enforcing "one non-terminal battle per room" means a battle stuck here
   * blocks every future battle in the room until an owner manually cancels
   * it. This is that backstop.
   *
   * Reuses `orphanTimeoutSeconds` rather than adding a new config field: it
   * is already exactly "how long a stuck, non-LIVE battle may sit before
   * this sweep forces a resolution" (see `sweepOrphans` above), just applied
   * to the pre-LIVE side of the lifecycle instead of the post-LIVE side.
   * CANCELLED (not settled — there is nothing to settle: no score, no
   * reward pool) is reachable from every one of these four statuses per
   * `VIDEO_ROOM_PK_TRANSITIONS`.
   */
  private async sweepStrandedPreLive(cfg: VideoRoomPkConfig, now: Date): Promise<void> {
    const cutoffMs = cfg.orphanTimeoutSeconds * 1000;
    for (const status of PK_PRE_LIVE_STATUSES) {
      const stuck = await this.repo.findByStatus(status, cfg.maxPerSweep);
      for (const battle of stuck) {
        if (now.getTime() - battle.createdAt.getTime() < cutoffMs) continue;
        try {
          const cancelled = await this.state.tryTransition(
            battle.id,
            status,
            VideoRoomPkStatus.CANCELLED,
            { cancelledAt: now, failureReason: 'Recovery: battle stranded before going LIVE.' },
          );
          if (cancelled) {
            this.logger.debug(
              `PK battle ${battle.id} in room ${battle.roomId} cancelled by recovery — stranded in ${status}`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `Recovery sweep failed to cancel stranded PK battle ${battle.id}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * A room's host dropped. `LIVE → RECOVERING` freezes the clock through the
   * SAME `pausedAt`/`totalPausedMs`/`resumeSeq` machinery an operator pause
   * uses (`VideoRoomPkService.pause`) — RECOVERING and PAUSED differ only in
   * who initiated the freeze, never in the mechanics. `tryTransition`, not
   * `transition`: this is a system reaction to a socket event, not a user
   * command awaiting a response, so losing a race (already RECOVERING, or
   * already moved on) is a silent no-op, not an error.
   *
   * Deliberately NOT gated on `recoveryEnabled` — that flag is the opt-in
   * switch for the periodic SWEEP's automatic settlement, not for freezing a
   * battle's clock the instant its host disconnects. `pause()`/`resume()`
   * check no such flag either.
   *
   * Guarded on `userId` actually being a PK participant of this battle: the
   * caller is room-wide presence (any member's socket dropping), and a
   * spectator or a member of a DIFFERENT ongoing battle in the same room
   * disconnecting must never freeze someone else's LIVE clock.
   */
  async handleHostDrop(roomId: string, userId: string): Promise<void> {
    const battle = await this.repo.findCurrent(roomId);
    if (!battle || battle.status !== VideoRoomPkStatus.LIVE) return;
    if (!(await this.isParticipant(battle.id, userId))) return;

    // Best-effort, mirrors `VideoRoomPkService.pause()` exactly: the
    // resumeSeq guard in the settlement job handler is the real protection
    // against a stale end job if this removal loses a race or fails outright.
    await this.timerService.cancelEnd({ id: battle.id, resumeSeq: battle.resumeSeq });

    const pausedAt = new Date(this.now());
    const recovering = await this.state.tryTransition(
      battle.id,
      VideoRoomPkStatus.LIVE,
      VideoRoomPkStatus.RECOVERING,
      { pausedAt, failureReason: `Host ${userId} disconnected.` },
    );
    if (!recovering) return; // lost the race — already moved by someone else

    this.logger.debug(
      `PK battle ${battle.id} in room ${roomId} entered RECOVERING (host ${userId} dropped)`,
    );
  }

  /**
   * The dropped host reconnected. Inside `recoveryGraceSeconds` of the drop,
   * this resumes exactly like an operator's `resume()` — same
   * `computeResume` arithmetic, same re-armed end job, same bumped
   * `resumeSeq` — because that IS what this is: a resume whose pause
   * happened to be system-initiated. Outside the grace window this is a
   * silent no-op; the battle stays RECOVERING for `sweepOrphans` to settle
   * with the scores as they stand on a later tick.
   *
   * Same participant guard as `handleHostDrop`: a different member of the
   * room reconnecting must not resume a battle they have no stake in.
   */
  async handleHostReturn(roomId: string, userId: string): Promise<void> {
    const battle = await this.repo.findCurrent(roomId);
    if (!battle || battle.status !== VideoRoomPkStatus.RECOVERING || !battle.pausedAt) return;
    if (!(await this.isParticipant(battle.id, userId))) return;

    const cfg = loadVideoRoomPkConfig(this.config);
    const now = new Date(this.now());
    const elapsedMs = now.getTime() - battle.pausedAt.getTime();
    if (elapsedMs > cfg.recoveryGraceSeconds * 1000) {
      this.logger.debug(
        `Host ${userId} returned to room ${roomId} after the PK grace window; battle ${battle.id} stays RECOVERING for the orphan sweep`,
      );
      return;
    }

    await this.resumeFromRecovering(battle, roomId, now);
  }

  /** Whether `userId` holds a `VideoRoomPkParticipant` row on this battle. */
  private async isParticipant(battleId: string, userId: string): Promise<boolean> {
    const rows = await this.repo.findParticipantsByUserIds(battleId, [userId]);
    return rows.length > 0;
  }

  /** Reuses `VideoRoomPkTimerService.computeResume` — never a parallel resume calculation. */
  private async resumeFromRecovering(
    battle: VideoRoomPkBattle,
    roomId: string,
    now: Date,
  ): Promise<void> {
    const computed = this.timerService.computeResume(battle, now);
    const resumed = await this.state.tryTransition(
      battle.id,
      VideoRoomPkStatus.RECOVERING,
      VideoRoomPkStatus.LIVE,
      {
        resumeSeq: computed.resumeSeq,
        totalPausedMs: computed.totalPausedMs,
        pausedAt: null,
        endsAt: computed.endsAt,
      },
    );
    if (!resumed) return; // lost the race — already resumed or settled elsewhere

    await this.timerService.scheduleEnd(
      { id: resumed.id, roomId, resumeSeq: resumed.resumeSeq, endsAt: resumed.endsAt },
      now,
    );

    await this.bus.publish(
      new PkRecoveredEvent({
        roomId,
        battleId: resumed.id,
        reason: 'HOST_RETURNED',
        previousStatus: VideoRoomPkStatus.RECOVERING,
        newStatus: VideoRoomPkStatus.LIVE,
      }),
    );
  }
}
