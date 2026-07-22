import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  VideoRoomPkBattle,
  VideoRoomPkParticipant,
  VideoRoomPkSide,
  VideoRoomPkStatus,
  VideoRoomPkTeam,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomPkConfig } from '../config/video-room-pk.config';
import { pkLifecycleLockKey } from '../constants/video-room-pk.constants';
import {
  AcceptPKInvitationDto,
  CreatePKInvitationDto,
  EndPKDto,
  PausePKDto,
  PKResponseDto,
  RejectPKInvitationDto,
  ResumePKDto,
  StartPKDto,
} from '../dto/video-room-pk.dto';
import {
  PkCreatedEvent,
  PkPausedEvent,
  PkResumedEvent,
  PkStartedEvent,
} from '../events/video-room-pk.events';
import { DuplicatePKException, PKBattleException } from '../exceptions/video-room-pk.exceptions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import { PkInviteeInput } from './video-room-pk-invitation.service';
import { VideoRoomPkInvitationService } from './video-room-pk-invitation.service';
import type { PkSettlementResult } from './video-room-pk-settlement.service';
import { VideoRoomPkScoreEngine } from './video-room-pk-score.engine';
import { VideoRoomPkStateService } from './video-room-pk-state.service';
import { VideoRoomPkTimerService } from './video-room-pk-timer.service';
import { VideoRoomPkValidationService } from './video-room-pk-validation.service';

/**
 * Task-18 seam. Settlement (winner computation, wallet payout, ENDED/
 * WINNER_DECLARED/REWARD_DISTRIBUTED events, transition to COMPLETED) does
 * not exist yet as of VR-12 Task 17. `end()` below delegates to whatever is
 * bound to this token; until Task 18 registers a real provider under it,
 * `end()` refuses the request with a clear domain error instead of doing
 * nothing (see the class doc on `end`).
 */
export const VIDEO_ROOM_PK_SETTLEMENT = Symbol('VIDEO_ROOM_PK_SETTLEMENT');

/** Why a battle is being settled — 'manual' is an owner/admin `end()` call, as here. */
export type PkSettlementTrigger = 'manual' | 'timer' | 'recovery';

/**
 * Widened (Task 24) to the ACTUAL shape `VideoRoomPkSettlementService.settle`
 * returns: `VideoRoomPkBattle` plus `settled`/`winningTeamId`/`isDraw`/
 * `poolAmount`/`allocatedAmount`. Declaring the narrower base type here would
 * force every caller that wants `.settled`/`.poolAmount` off `end()`'s result
 * into an unsound cast; declaring the true intersection means TypeScript
 * checks the real implementation against it instead of trusting an assertion.
 */
export interface IVideoRoomPkSettlementService {
  settle(
    battleId: string,
    trigger: PkSettlementTrigger,
  ): Promise<VideoRoomPkBattle & PkSettlementResult>;
}

/** Statuses `end()` may settle from. */
const ENDABLE: readonly VideoRoomPkStatus[] = [VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED];

/**
 * Prisma's shape for a unique-constraint violation error, narrowed to just
 * the two fields `invite()`'s duplicate-battle mapping needs.
 */
interface PrismaUniqueViolation {
  code?: string;
  meta?: { target?: string | string[] };
}

function isDuplicateBattleViolation(err: unknown): boolean {
  const candidate = err as PrismaUniqueViolation;
  if (candidate?.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  const targets = Array.isArray(target) ? target : [target];
  return targets.some(
    (t) => typeof t === 'string' && t.includes('video_room_pk_battles_one_active_per_room'),
  );
}

/**
 * VR-12 PK lifecycle facade (Task 17): the 8 owner/admin commands — invite,
 * accept, reject, cancel, start, pause, resume, end. Task 22's REST
 * controller is a thin layer over this.
 *
 * Every command serialises under {@link pkLifecycleLockKey}: two owner
 * commands racing on the same room (a double-tap "start", an accept landing
 * next to a cancel) are resolved by the lock, and the conditional UPDATE
 * inside `VideoRoomPkStateService.transition` is the second, database-level
 * line of defence for the same race — the lock makes it rare, the CAS makes
 * it correct even when it happens anyway.
 */
@Injectable()
export class VideoRoomPkService {
  private readonly logger = new Logger(VideoRoomPkService.name);

  constructor(
    private readonly repo: VideoRoomPkRepository,
    private readonly validation: VideoRoomPkValidationService,
    private readonly state: VideoRoomPkStateService,
    private readonly timer: VideoRoomPkTimerService,
    private readonly invitations: VideoRoomPkInvitationService,
    private readonly scoreEngine: VideoRoomPkScoreEngine,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
    @Optional()
    @Inject(VIDEO_ROOM_PK_SETTLEMENT)
    private readonly settlement?: IVideoRoomPkSettlementService,
  ) {}

  /**
   * Create the battle and its invitations.
   *
   * The scoring and reward snapshots are frozen HERE, from config, and never
   * re-read afterwards — no later command in this file touches
   * `scoringSnapshot`/`rewardSnapshot` again. An admin retuning multipliers or
   * the pool share mid-battle must not change the rules of a battle already
   * in flight, the same reason VR-11 freezes its level ladder into the
   * session.
   *
   * Battle + teams + participants commit in ONE transaction
   * (`repo.runInTransaction`); invitations are created AFTER that commits,
   * deliberately outside it — `VideoRoomPkInvitationRepository.create` (Task
   * 16) is called without a db/tx parameter, so it structurally cannot join
   * this transaction. A crash between the commit and `invitations.send()`
   * completing leaves a battle with no invitations; Task 20's recovery sweep
   * is what must expire/cancel that orphan.
   */
  async invite(
    actor: RoomActor,
    roomId: string,
    dto: CreatePKInvitationDto,
    requestId?: string,
  ): Promise<PKResponseDto> {
    const cfg = loadVideoRoomPkConfig(this.config);
    await this.validation.assertCanCreate(actor, roomId, dto);

    // `dto.durationSeconds` is optional (see the DTO's own comment); when
    // omitted, `defaultDurationSeconds` supplies it. Resolved ONCE here, both
    // gates already validated against this exact fallback in
    // `VideoRoomPkValidationService.assertCanCreate`'s gate 2.
    const durationSeconds = dto.durationSeconds ?? cfg.defaultDurationSeconds;

    return this.locks.withLock(pkLifecycleLockKey(roomId), async () => {
      const scoringSnapshot = this.scoreEngine.snapshot(cfg);
      const rewardSnapshot = {
        poolBps: cfg.poolBps,
        winnerBps: cfg.winnerBps,
        participationBps: cfg.participationBps,
        bonusBps: cfg.bonusBps,
      };

      let battle: VideoRoomPkBattle;
      try {
        battle = await this.repo.runInTransaction(async (tx) => {
          const created = await this.repo.createBattle(
            {
              roomId,
              mode: dto.mode,
              createdBy: actor.id,
              countdownSeconds: cfg.countdownSeconds,
              durationSeconds,
              scoringSnapshot: scoringSnapshot as unknown as Prisma.InputJsonValue,
              rewardSnapshot: rewardSnapshot as unknown as Prisma.InputJsonValue,
            },
            tx,
          );

          // Team ids are generated here, client-side, so the participant rows
          // below can reference them without a re-read inside the transaction.
          const redTeamId = randomUUID();
          const blueTeamId = randomUUID();
          await this.repo.createTeams(
            [
              { id: redTeamId, battleId: created.id, roomId, side: VideoRoomPkSide.RED },
              { id: blueTeamId, battleId: created.id, roomId, side: VideoRoomPkSide.BLUE },
            ],
            tx,
          );
          await this.repo.createParticipants(
            [
              ...dto.red.map((userId) => ({
                id: randomUUID(),
                battleId: created.id,
                teamId: redTeamId,
                roomId,
                userId,
                side: VideoRoomPkSide.RED,
              })),
              ...dto.blue.map((userId) => ({
                id: randomUUID(),
                battleId: created.id,
                teamId: blueTeamId,
                roomId,
                userId,
                side: VideoRoomPkSide.BLUE,
              })),
            ],
            tx,
          );

          return created;
        });
      } catch (err) {
        if (isDuplicateBattleViolation(err)) {
          throw new DuplicatePKException('This room already has a PK battle in progress.');
        }
        throw err;
      }

      await this.bus.publish(
        new PkCreatedEvent({
          roomId,
          battleId: battle.id,
          mode: dto.mode,
          createdBy: actor.id,
          durationSeconds,
          requestId,
        }),
      );

      // Side is derived from which of the DTO's two arrays an invitee is in —
      // passing bare userIds here would silently default every invitee to
      // RED (see `VideoRoomPkInvitationService`'s `normalizeInvitee`).
      const invitees: PkInviteeInput[] = [
        ...dto.red.map((userId) => ({ userId, side: VideoRoomPkSide.RED })),
        ...dto.blue.map((userId) => ({ userId, side: VideoRoomPkSide.BLUE })),
      ];
      await this.invitations.send(battle, invitees, actor.id);
      this.logger.debug(
        `PK battle ${battle.id} invited in room ${roomId} (request ${requestId ?? 'n/a'})`,
      );

      const invited = await this.state.transition(
        battle.id,
        VideoRoomPkStatus.CREATED,
        VideoRoomPkStatus.INVITED,
      );
      return this.toResponse(invited);
    });
  }

  /**
   * Deliberately NO room-permission gate here. Authority to accept is
   * "being the named invitee" — a row lookup inside
   * `VideoRoomPkInvitationService.accept`, not a room role — so an OWNER/
   * ADMIN holding `START_PK` gains nothing from it: they still cannot accept
   * on someone else's behalf. Do not "fix" this to match the five
   * room-authority-gated commands below; the asymmetry is intentional.
   */
  async accept(
    actor: RoomActor,
    roomId: string,
    dto: AcceptPKInvitationDto,
    requestId?: string,
  ): Promise<PKResponseDto> {
    return this.locks.withLock(pkLifecycleLockKey(roomId), async () => {
      const battle = await this.resolveBattle(roomId, dto.battleId);
      await this.invitations.accept(actor.id, battle);
      this.logger.debug(
        `PK invitation accepted by ${actor.id} on battle ${battle.id} (request ${requestId ?? 'n/a'})`,
      );
      const refreshed = (await this.repo.getBattle(battle.id)) ?? battle;
      return this.toResponse(refreshed);
    });
  }

  /**
   * Deliberately NO room-permission gate here, for the same reason as
   * `accept` above: authority to reject is "being the named invitee", not a
   * room role. The opponent declining a challenge is not managing this
   * room's PK battle.
   */
  async reject(
    actor: RoomActor,
    roomId: string,
    dto: RejectPKInvitationDto,
    requestId?: string,
  ): Promise<PKResponseDto> {
    return this.locks.withLock(pkLifecycleLockKey(roomId), async () => {
      const battle = await this.resolveBattle(roomId, dto.battleId);
      await this.invitations.reject(actor.id, battle);
      this.logger.debug(
        `PK invitation rejected by ${actor.id} on battle ${battle.id} (request ${requestId ?? 'n/a'})`,
      );
      const refreshed = (await this.repo.getBattle(battle.id)) ?? battle;
      return this.toResponse(refreshed);
    });
  }

  /**
   * `VideoRoomPkInvitationService.cancelAll` only cancels the invitation
   * rows — it deliberately does NOT transition the battle (Task 16), because
   * it never has the battle row to transition. This method holds the battle,
   * so it owns that transition itself.
   */
  async cancel(actor: RoomActor, roomId: string, requestId?: string): Promise<PKResponseDto> {
    await this.validation.assertCanManage(actor, roomId);
    return this.locks.withLock(pkLifecycleLockKey(roomId), async () => {
      const battle = await this.requireCurrent(roomId);
      const reason = `Cancelled by ${actor.id}.`;
      await this.invitations.cancelAll(battle.id, reason);
      const cancelled = await this.state.transition(
        battle.id,
        battle.status,
        VideoRoomPkStatus.CANCELLED,
        {
          cancelledAt: new Date(),
          failureReason: reason,
        },
      );
      this.logger.debug(
        `PK battle ${battle.id} cancelled by ${actor.id} (request ${requestId ?? 'n/a'})`,
      );
      return this.toResponse(cancelled);
    });
  }

  async start(
    actor: RoomActor,
    roomId: string,
    dto: StartPKDto,
    requestId?: string,
  ): Promise<PKResponseDto> {
    await this.validation.assertCanManage(actor, roomId);
    return this.locks.withLock(pkLifecycleLockKey(roomId), async () => {
      const battle = await this.requireCurrent(roomId);
      if (battle.status !== VideoRoomPkStatus.ACCEPTED) {
        throw new PKBattleException(
          `A PK battle cannot start from ${battle.status}; every invitee must accept first.`,
        );
      }

      const now = new Date();
      const countdownSeconds = dto.countdownSeconds ?? battle.countdownSeconds;
      const endsAt = new Date(
        now.getTime() + countdownSeconds * 1000 + battle.durationSeconds * 1000,
      );

      const started = await this.state.transition(
        battle.id,
        VideoRoomPkStatus.ACCEPTED,
        VideoRoomPkStatus.COUNTDOWN,
        { startedAt: now, endsAt, countdownSeconds },
      );
      await this.timer.scheduleCountdown(
        {
          id: started.id,
          roomId,
          resumeSeq: started.resumeSeq,
          countdownSeconds: started.countdownSeconds,
        },
        now,
      );

      const [teams, participants] = await this.loadSides(started.id);
      await this.bus.publish(
        new PkStartedEvent({
          roomId,
          battleId: started.id,
          mode: started.mode,
          countdownSeconds: started.countdownSeconds,
          durationSeconds: started.durationSeconds,
          startedAt: now.toISOString(),
          endsAt: endsAt.toISOString(),
          teams: teams.map(toTeamView),
          participants: participants.map((p) => ({
            userId: p.userId,
            side: p.side,
            teamId: p.teamId,
          })),
          requestId,
        }),
      );
      this.logger.debug(
        `PK battle ${started.id} started in room ${roomId} (request ${requestId ?? 'n/a'})`,
      );
      return this.toResponse(started, teams, participants);
    });
  }

  /** From LIVE only. Refuses a COUNTDOWN battle (or any other state) rather than silently no-opping. */
  async pause(
    actor: RoomActor,
    roomId: string,
    dto: PausePKDto,
    requestId?: string,
  ): Promise<PKResponseDto> {
    await this.validation.assertCanManage(actor, roomId);
    return this.locks.withLock(pkLifecycleLockKey(roomId), async () => {
      const battle = await this.requireCurrent(roomId);
      if (battle.status !== VideoRoomPkStatus.LIVE) {
        throw new PKBattleException(
          `A PK battle cannot be paused from ${battle.status}; it must be LIVE.`,
        );
      }

      // Best-effort: the resumeSeq guard (see VideoRoomPkTimerService class
      // doc) is what actually protects against the stale-job hazard if this
      // removal loses a race or fails outright.
      await this.timer.cancelEnd({ id: battle.id, resumeSeq: battle.resumeSeq });

      const pausedAt = new Date();
      const remainingMs = battle.endsAt
        ? Math.max(0, battle.endsAt.getTime() - pausedAt.getTime())
        : 0;
      const paused = await this.state.transition(
        battle.id,
        VideoRoomPkStatus.LIVE,
        VideoRoomPkStatus.PAUSED,
        {
          pausedAt,
          failureReason: dto.reason ?? null,
        },
      );

      await this.bus.publish(
        new PkPausedEvent({
          roomId,
          battleId: paused.id,
          pausedAt: pausedAt.toISOString(),
          remainingMs,
          involuntary: false,
          requestId,
        }),
      );
      this.logger.debug(
        `PK battle ${paused.id} paused by ${actor.id} (request ${requestId ?? 'n/a'})`,
      );
      return this.toResponse(paused);
    });
  }

  /** From PAUSED only. `computeResume` supplies the recomputed `endsAt` and the bumped `resumeSeq`. */
  async resume(
    actor: RoomActor,
    roomId: string,
    dto: ResumePKDto,
    requestId?: string,
  ): Promise<PKResponseDto> {
    await this.validation.assertCanManage(actor, roomId);
    return this.locks.withLock(pkLifecycleLockKey(roomId), async () => {
      const battle = await this.requireCurrent(roomId);
      if (battle.status !== VideoRoomPkStatus.PAUSED) {
        throw new PKBattleException(
          `A PK battle cannot resume from ${battle.status}; it must be PAUSED.`,
        );
      }

      const now = new Date();
      const computed = this.timer.computeResume(battle, now);
      const resumed = await this.state.transition(
        battle.id,
        VideoRoomPkStatus.PAUSED,
        VideoRoomPkStatus.LIVE,
        {
          resumeSeq: computed.resumeSeq,
          totalPausedMs: computed.totalPausedMs,
          pausedAt: null,
          endsAt: computed.endsAt,
        },
      );
      await this.timer.scheduleEnd(
        { id: resumed.id, roomId, resumeSeq: resumed.resumeSeq, endsAt: resumed.endsAt },
        now,
      );

      await this.bus.publish(
        new PkResumedEvent({
          roomId,
          battleId: resumed.id,
          resumedAt: now.toISOString(),
          endsAt: computed.endsAt.toISOString(),
          resumeSeq: computed.resumeSeq,
          requestId,
        }),
      );
      this.logger.debug(
        `PK battle ${resumed.id} resumed by ${actor.id} (request ${requestId ?? 'n/a'}), reason: ${dto.reason ?? 'n/a'}`,
      );
      return this.toResponse(resumed);
    });
  }

  /**
   * From LIVE or PAUSED. Settlement itself — winner computation, reward
   * payout, the COMPLETED transition, and the ENDED/WINNER_DECLARED/
   * REWARD_DISTRIBUTED events — is Task 18's job, not this lifecycle
   * facade's. `end()` only authorizes the request and hands off to whatever
   * is bound to {@link VIDEO_ROOM_PK_SETTLEMENT}.
   *
   * Until Task 18 registers a real provider under that token, this throws a
   * clear `PKBattleException` rather than doing nothing — an owner tapping
   * "end" must never see a request that silently succeeds and changes
   * nothing.
   */
  async end(
    actor: RoomActor,
    roomId: string,
    dto: EndPKDto,
    requestId?: string,
  ): Promise<PKResponseDto> {
    await this.validation.assertCanManage(actor, roomId);
    return this.locks.withLock(pkLifecycleLockKey(roomId), async () => {
      const battle = await this.requireCurrent(roomId);
      if (!ENDABLE.includes(battle.status)) {
        throw new PKBattleException(
          `A PK battle cannot be ended from ${battle.status}; it must be LIVE or PAUSED.`,
        );
      }
      if (!this.settlement) {
        throw new PKBattleException(
          'PK settlement is not available yet.',
          HttpStatus.NOT_IMPLEMENTED,
        );
      }

      this.logger.debug(
        `PK battle ${battle.id} ended manually by ${actor.id} (request ${requestId ?? 'n/a'}), reason: ${dto.reason ?? 'n/a'}`,
      );
      const settled = await this.settlement.settle(battle.id, 'manual');
      return this.toResponse(settled ?? battle);
    });
  }

  // ---- internals ----

  private async requireCurrent(roomId: string): Promise<VideoRoomPkBattle> {
    const battle = await this.repo.findCurrent(roomId);
    if (!battle) {
      throw new PKBattleException(
        'No PK battle is in progress in this room.',
        HttpStatus.NOT_FOUND,
      );
    }
    return battle;
  }

  /** `accept`/`reject` may target an explicit battleId, or default to the room's current battle. */
  private async resolveBattle(roomId: string, battleId?: string): Promise<VideoRoomPkBattle> {
    if (!battleId) return this.requireCurrent(roomId);
    const battle = await this.repo.getBattle(battleId);
    if (!battle) {
      throw new PKBattleException('PK battle not found.', HttpStatus.NOT_FOUND);
    }
    return battle;
  }

  private loadSides(battleId: string): Promise<[VideoRoomPkTeam[], VideoRoomPkParticipant[]]> {
    return Promise.all([this.repo.listTeams(battleId), this.repo.listParticipants(battleId)]);
  }

  private async toResponse(
    battle: VideoRoomPkBattle,
    teams?: VideoRoomPkTeam[],
    participants?: VideoRoomPkParticipant[],
  ): Promise<PKResponseDto> {
    const [loadedTeams, loadedParticipants] =
      teams && participants ? [teams, participants] : await this.loadSides(battle.id);

    return {
      active: true,
      id: battle.id,
      roomId: battle.roomId,
      mode: battle.mode,
      status: battle.status,
      countdownSeconds: battle.countdownSeconds,
      durationSeconds: battle.durationSeconds,
      startedAt: battle.startedAt ? battle.startedAt.toISOString() : null,
      endsAt: battle.endsAt ? battle.endsAt.toISOString() : null,
      serverTime: new Date().toISOString(),
      isDraw: battle.isDraw,
      winningTeamId: battle.winningTeamId,
      teams: loadedTeams.map((t) => ({ teamId: t.id, side: t.side, score: Number(t.score) })),
      participants: loadedParticipants.map((p) => ({
        userId: p.userId,
        teamId: p.teamId,
        side: p.side,
        score: Number(p.score),
        giftCount: p.giftCount,
      })),
    };
  }
}

function toTeamView(t: VideoRoomPkTeam): { teamId: string; side: string; score: number } {
  return { teamId: t.id, side: t.side, score: Number(t.score) };
}
