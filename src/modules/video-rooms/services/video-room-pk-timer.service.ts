import { Injectable, Logger } from '@nestjs/common';
import { VideoRoomPkBattle } from '@prisma/client';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import {
  VIDEO_ROOM_PK_END_JOB,
  VIDEO_ROOM_PK_START_JOB,
} from '../constants/video-room-pk.constants';

/** Payload of both the `video-room.pk.start` and `video-room.pk.end` BullMQ jobs. */
export interface PkTimerJob {
  roomId: string;
  battleId: string;
  resumeSeq: number;
}

/** Result of {@link VideoRoomPkTimerService.computeResume}. */
export interface PkResumeComputation {
  endsAt: Date;
  totalPausedMs: number;
  resumeSeq: number;
}

type CountdownInput = Pick<VideoRoomPkBattle, 'id' | 'roomId' | 'resumeSeq' | 'countdownSeconds'>;
type EndInput = Pick<VideoRoomPkBattle, 'id' | 'roomId' | 'resumeSeq' | 'endsAt'>;
type ResumeInput = Pick<VideoRoomPkBattle, 'endsAt' | 'pausedAt' | 'totalPausedMs' | 'resumeSeq'>;
type CancelInput = Pick<VideoRoomPkBattle, 'id' | 'resumeSeq'>;

/**
 * Owns every clock-facing operation of the VR-12 PK engine: scheduling the two
 * BullMQ jobs that drive the state machine forward on their own (COUNTDOWN →
 * LIVE, LIVE → COMPLETED) and the pause/resume arithmetic that keeps `endsAt`
 * honest across a pause.
 *
 * ## Why `resumeSeq` exists
 * When a battle is paused, an end job is already sitting in the queue with a
 * delay computed BEFORE the pause. Removing that job (see {@link cancelEnd})
 * can fail — a Redis blip, or simply losing a race with the job becoming
 * active — so removal is best-effort, not a guarantee. Every resume instead
 * bumps `resumeSeq` via {@link computeResume}: the stale job's id and payload
 * still carry the OLD sequence, and the VR-12 settlement job handler drops any
 * `video-room.pk.end` job whose `resumeSeq` no longer matches the battle row.
 * Without this guard, a pause immediately followed by a resume would leave the
 * pre-pause job live in the queue, and it would settle the battle EARLY — mid
 * battle, against whatever scores existed at the old deadline.
 */
@Injectable()
export class VideoRoomPkTimerService {
  private readonly logger = new Logger(VideoRoomPkTimerService.name);

  constructor(private readonly queueService: QueueService) {}

  /**
   * Schedules the COUNTDOWN → LIVE transition.
   *
   * The jobId is battle-scoped only, with no `resumeSeq`: per
   * `VIDEO_ROOM_PK_TRANSITIONS`, COUNTDOWN can only move to LIVE, CANCELLED or
   * FAILED — it can never be paused — so there is no stale-job hazard to guard
   * against here.
   */
  async scheduleCountdown(battle: CountdownInput, now: Date): Promise<void> {
    const jobId = `pk-start:${battle.id}`;
    const delayMs = Math.max(0, battle.countdownSeconds * 1000);
    const targetAt = new Date(now.getTime() + delayMs);
    this.logger.debug(
      `Scheduling PK countdown-end for battle ${battle.id}, target ${targetAt.toISOString()}`,
    );

    const payload: PkTimerJob = {
      roomId: battle.roomId,
      battleId: battle.id,
      resumeSeq: battle.resumeSeq,
    };

    await this.queueService.enqueueDelayed(
      QUEUE_NAMES.GIFT_PROCESSING,
      VIDEO_ROOM_PK_START_JOB,
      payload,
      delayMs,
      { jobId },
    );
  }

  /**
   * Schedules the LIVE → COMPLETED transition. The jobId embeds the battle's
   * CURRENT `resumeSeq` — see the class doc for why that is load-bearing rather
   * than decorative: it is what lets the settlement handler recognise and drop
   * a job left behind by an earlier pause/resume cycle.
   */
  async scheduleEnd(battle: EndInput, now: Date): Promise<void> {
    const jobId = `pk-end:${battle.id}:${battle.resumeSeq}`;
    const payload: PkTimerJob = {
      roomId: battle.roomId,
      battleId: battle.id,
      resumeSeq: battle.resumeSeq,
    };

    await this.queueService.enqueueDelayed(
      QUEUE_NAMES.GIFT_PROCESSING,
      VIDEO_ROOM_PK_END_JOB,
      payload,
      this.remainingMs(battle, now),
      { jobId },
    );
  }

  /**
   * Best-effort cancellation of the pending end job for the battle's CURRENT
   * `resumeSeq`, called on pause.
   *
   * `QueueService` (src/infra/queue/queue.service.ts, frozen for this phase)
   * exposes no `remove` method — only the public `getQueue(name)` accessor
   * already used elsewhere in this module (e.g. `VideoRoomTreasureUnlockService`
   * via `QueueJobRegistry`). This goes through that accessor and calls BullMQ's
   * own `Queue.remove(jobId)` rather than adding anything to shared infra.
   *
   * Removal is inherently best-effort: the job may already be active, already
   * gone, or the call may simply fail transiently. Failures are swallowed and
   * logged — correctness never depends on this call succeeding. It rests
   * entirely on the `resumeSeq` guard described in the class doc, which is why
   * that guard is mandatory in the settlement handler, not defensive.
   */
  async cancelEnd(battle: CancelInput): Promise<void> {
    const jobId = `pk-end:${battle.id}:${battle.resumeSeq}`;
    try {
      await this.queueService.getQueue(QUEUE_NAMES.GIFT_PROCESSING).remove(jobId);
    } catch (err) {
      this.logger.warn(`Failed to cancel PK end job ${jobId}: ${(err as Error).message}`);
    }
  }

  /**
   * Resume arithmetic.
   *
   * `endsAt` moves forward by exactly the paused duration, so a 300-second
   * battle paused for two minutes still has its full remaining time. Bumping
   * `resumeSeq` is what neutralises the job scheduled before the pause: it
   * carries the OLD sequence, and the settlement handler drops any job whose
   * `resumeSeq` no longer matches the row. Without it, a pause/resume cycle
   * would leave a stale job that settles the battle early.
   *
   * `pausedAt`/`endsAt` may be null (a resume racing an already-cleared pause,
   * or a battle that never got a deadline); both degrade to 0/`now` rather than
   * producing NaN or an Invalid Date.
   */
  computeResume(battle: ResumeInput, now: Date): PkResumeComputation {
    const pausedFor = battle.pausedAt ? now.getTime() - battle.pausedAt.getTime() : 0;
    return {
      endsAt: new Date((battle.endsAt?.getTime() ?? now.getTime()) + pausedFor),
      totalPausedMs: battle.totalPausedMs + pausedFor,
      resumeSeq: battle.resumeSeq + 1,
    };
  }

  /**
   * Clamped at 0: BullMQ treats a negative delay as immediate anyway, and an
   * explicit 0 keeps the intent readable in the queue dashboard. A null
   * `endsAt` also degrades to 0 rather than NaN.
   */
  remainingMs(battle: Pick<VideoRoomPkBattle, 'endsAt'>, now: Date): number {
    return Math.max(0, (battle.endsAt?.getTime() ?? now.getTime()) - now.getTime());
  }
}
