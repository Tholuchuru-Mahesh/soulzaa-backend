import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { VideoRoomPkBattle, VideoRoomPkStatus } from '@prisma/client';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import {
  isPkTerminal,
  VIDEO_ROOM_PK_END_JOB,
  VIDEO_ROOM_PK_START_JOB,
} from '../constants/video-room-pk.constants';
import { PKCountdownException } from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import { VideoRoomPkSettlementService } from './video-room-pk-settlement.service';
import { VideoRoomPkStateService } from './video-room-pk-state.service';
import { VideoRoomPkTimerService, type PkTimerJob } from './video-room-pk-timer.service';

/**
 * VR-12 Task 19: the two BullMQ handlers that drive the PK clock forward on
 * their own — `video-room.pk.start` (COUNTDOWN → LIVE) and
 * `video-room.pk.end` (LIVE|PAUSED → COMPLETED via settlement). Registered
 * on the shared gift queue through {@link QueueJobRegistry}, mirroring
 * `VideoRoomTreasureUnlockService`'s `onModuleInit`.
 *
 * Both handlers are written to be silently safe against a battle that no
 * longer exists (deleted, or a job that outlived a battle that was never
 * committed): they return quietly instead of throwing. An exception here
 * would burn BullMQ's retries and eventually dead-letter a job that can
 * never succeed no matter how many times it is retried.
 */
@Injectable()
export class VideoRoomPkJobsService implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomPkJobsService.name);

  constructor(
    private readonly registry: QueueJobRegistry,
    private readonly repo: VideoRoomPkRepository,
    private readonly state: VideoRoomPkStateService,
    private readonly timer: VideoRoomPkTimerService,
    private readonly settlement: VideoRoomPkSettlementService,
  ) {}

  onModuleInit(): void {
    this.registry.register(QUEUE_NAMES.GIFT_PROCESSING, VIDEO_ROOM_PK_START_JOB, (data) =>
      this.handleStart(data as PkTimerJob),
    );
    this.registry.register(QUEUE_NAMES.GIFT_PROCESSING, VIDEO_ROOM_PK_END_JOB, (data) =>
      this.handleEnd(data as PkTimerJob),
    );
  }

  /**
   * COUNTDOWN → LIVE. `endsAt` was already frozen when the owner called
   * `start()` (countdown + duration from that moment — see
   * `VideoRoomPkService.start`), so there is nothing to recompute here; this
   * only flips the status and arms the end timer against the existing
   * deadline.
   *
   * Guarded against duplicate delivery: a battle no longer in COUNTDOWN
   * (already LIVE from an earlier delivery of this same job, or moved to
   * CANCELLED/FAILED in the meantime) is left untouched rather than forced
   * into LIVE.
   *
   * Between that read and the transition below, a race is still possible —
   * a cancel landing in the gap — in which case `state.transition`'s CAS
   * loses and throws. That case is deliberately NOT swallowed: it is
   * rethrown as {@link PKCountdownException} rather than left as the
   * generic `PKBattleException` the state service raises, so this specific
   * "the countdown could not be advanced" failure is distinguishable from
   * every other PK conflict. Retrying this exact job is safe — the guard
   * above will find the battle no longer COUNTDOWN on the next delivery and
   * quietly no-op, so this is not the "can never succeed" case the class
   * doc otherwise avoids feeding to BullMQ's retries.
   */
  async handleStart(job: PkTimerJob): Promise<void> {
    const battle = await this.repo.getBattle(job.battleId);
    if (!battle) {
      this.logger.debug(`PK start job for battle ${job.battleId} — battle no longer exists`);
      return;
    }
    if (battle.status !== VideoRoomPkStatus.COUNTDOWN) {
      this.logger.debug(
        `PK start job for battle ${battle.id} — status is ${battle.status}, not COUNTDOWN; skipping`,
      );
      return;
    }

    const now = new Date();
    let live: VideoRoomPkBattle;
    try {
      live = await this.state.transition(
        battle.id,
        VideoRoomPkStatus.COUNTDOWN,
        VideoRoomPkStatus.LIVE,
        {},
      );
    } catch (err) {
      throw new PKCountdownException(
        `PK countdown for battle ${battle.id} could not advance to LIVE: ${(err as Error).message}`,
      );
    }
    await this.timer.scheduleEnd(live, now);
  }

  /**
   * LIVE|PAUSED → COMPLETED via settlement.
   *
   * The `resumeSeq` check below is THE guarantee that pause/resume is safe
   * against a job that was already sitting in the queue, not a
   * belt-and-braces extra on top of `VideoRoomPkTimerService.cancelEnd`.
   * `cancelEnd` only attempts to remove the pending end job on pause, and
   * that removal is explicitly best-effort — a Redis blip, or simply losing
   * a race with the job becoming active, can leave it in place. Every
   * resume instead bumps the battle's `resumeSeq`
   * (`VideoRoomPkTimerService.computeResume`), and the job payload carries
   * whatever `resumeSeq` was current when it was scheduled. A mismatch here
   * means this job predates the most recent resume and MUST be dropped
   * unconditionally: running it anyway would settle the battle EARLY — mid
   * pause, against whatever scores existed at the old deadline, paying out
   * real currency for a battle that was never actually over.
   *
   * Also guarded against a battle that is already terminal (settled by an
   * earlier delivery of this same job, or cancelled/failed independently):
   * `VideoRoomPkSettlementService.settle` is itself replay-safe, but
   * skipping the call entirely here avoids even attempting a settlement
   * that would just no-op.
   */
  async handleEnd(job: PkTimerJob): Promise<void> {
    const battle = await this.repo.getBattle(job.battleId);
    if (!battle) {
      this.logger.debug(`PK end job for battle ${job.battleId} — battle no longer exists`);
      return;
    }
    if (battle.resumeSeq !== job.resumeSeq) {
      this.logger.debug(
        `PK end job for battle ${battle.id} — stale resumeSeq (job ${job.resumeSeq}, battle ${battle.resumeSeq}); dropping`,
      );
      return;
    }
    if (isPkTerminal(battle.status)) {
      this.logger.debug(
        `PK end job for battle ${battle.id} — already terminal (${battle.status}); skipping settlement`,
      );
      return;
    }

    await this.settlement.settle(battle.id, 'timer');
  }
}
