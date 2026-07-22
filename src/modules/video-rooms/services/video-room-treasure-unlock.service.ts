import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BackpackItemSource,
  Prisma,
  TreasureBox,
  TreasureBoxStatus,
  TreasureSessionStatus,
  WalletTxnReason,
} from '@prisma/client';
import type { Job } from 'bullmq';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { LockService } from 'src/infra/redis/lock.service';
import { RewardDistributor } from 'src/modules/treasure-boxes/services/reward-distributor.service';
import { loadVideoRoomTreasureConfig } from '../config/video-room-treasure.config';
import {
  TreasureUnlockStage,
  treasureUnlockLockKey,
  VIDEO_ROOM_TREASURE_QUEUE_JOB,
} from '../constants/video-room-treasure.constants';
import {
  TreasureRewardDistributedEvent,
  TreasureRewardGeneratedEvent,
  TreasureUnlockedEvent,
  TreasureUnlockFailedEvent,
  TreasureWinnerSelectedEvent,
} from '../events/video-room-treasure.events';
import { TreasureUnlockException } from '../exceptions/video-room-treasure.exceptions';
import { VideoRoomTreasureRewardRepository } from '../repositories/video-room-treasure-reward.repository';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';
import type { VideoRoomTreasureUnlockJob } from './video-room-gift-context.handler';
import { VideoRoomTreasureEligibilityService } from './video-room-treasure-eligibility.service';
import {
  VideoRoomTreasurePoolService,
  type PoolAllocation,
  type TreasureLevelRules,
} from './video-room-treasure-pool.service';
import { VideoRoomTreasureProgressService } from './video-room-treasure-progress.service';
import { VideoRoomTreasureWinnerService } from './video-room-treasure-winner.service';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

export interface UnlockResult {
  replayed: boolean;
  winners: number;
  poolAmount: number;
}

/**
 * Session states whose in-flight boxes still complete. PAUSED is deliberate:
 * the box was claimed before the pause, so its winners are already owed.
 */
const UNLOCKABLE: TreasureSessionStatus[] = [
  TreasureSessionStatus.ACTIVE,
  TreasureSessionStatus.PAUSED,
];

/**
 * The unlock pipeline (VR-11 spec §6.4).
 *
 * Runs on the shared gift queue via the job registry, so it inherits BullMQ's
 * retry, backoff and dead-lettering rather than reimplementing them. Errors are
 * rethrown deliberately — that is what drives a retry and eventually the DLQ the
 * recovery monitor replays.
 *
 * Pool, eligibility and winner selection run BEFORE the transaction opens:
 * holding a Postgres transaction across a Redis round-trip exhausts the
 * connection pool under load. The unique constraints on the pool and winner rows
 * make a retry that re-draws different winners fail closed rather than double-pay.
 */
@Injectable()
export class VideoRoomTreasureUnlockService implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomTreasureUnlockService.name);
  private inFlight = 0;

  constructor(
    private readonly registry: QueueJobRegistry,
    private readonly locks: LockService,
    private readonly prisma: PrismaService,
    private readonly repo: VideoRoomTreasureRepository,
    private readonly rewards: VideoRoomTreasureRewardRepository,
    private readonly pool: VideoRoomTreasurePoolService,
    private readonly eligibility: VideoRoomTreasureEligibilityService,
    private readonly winners: VideoRoomTreasureWinnerService,
    private readonly distributor: RewardDistributor,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
    private readonly progress: VideoRoomTreasureProgressService,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      QUEUE_NAMES.GIFT_PROCESSING,
      VIDEO_ROOM_TREASURE_QUEUE_JOB,
      (data, job: Job) =>
        this.handle(data as VideoRoomTreasureUnlockJob, (job.attemptsMade ?? 0) + 1),
    );
  }

  async handle(job: VideoRoomTreasureUnlockJob, attempt: number): Promise<UnlockResult> {
    // Tracked around the lock, not inside it: a job waiting on a busy room IS
    // in flight from an operator's point of view, and a gauge that only counted
    // the lock holder would read 1 no matter how deep the queue got.
    this.metrics.setTreasureInFlight((this.inFlight += 1));
    try {
      return await this.runUnlock(job, attempt);
    } finally {
      this.metrics.setTreasureInFlight((this.inFlight -= 1));
    }
  }

  private async runUnlock(job: VideoRoomTreasureUnlockJob, attempt: number): Promise<UnlockResult> {
    return this.locks.withLock(treasureUnlockLockKey(job.roomId), async () => {
      let stage: TreasureUnlockStage = TreasureUnlockStage.VALIDATE;
      try {
        // ---- 1 VALIDATE ----
        const box = await this.repo.getBox(job.boxId);
        if (!box) throw new TreasureUnlockException(`Treasure box ${job.boxId} not found.`);
        if (box.status === TreasureBoxStatus.OPENED) {
          this.logger.debug(`Unlock replay for box ${job.boxId} — already opened`);
          return { replayed: true, winners: 0, poolAmount: 0 };
        }
        if (box.status !== TreasureBoxStatus.UNLOCKING) {
          throw new TreasureUnlockException(
            `Box ${job.boxId} is ${box.status}, expected UNLOCKING.`,
          );
        }

        const session = await this.repo.getSession(job.sessionId);
        if (!session || !UNLOCKABLE.includes(session.status)) {
          throw new TreasureUnlockException(
            `Session ${job.sessionId} is ${session?.status ?? 'missing'}, not unlockable.`,
          );
        }

        const snapshot = await this.repo.getSnapshot(job.sessionId);
        const rules = (
          snapshot?.levelSnapshot as unknown as TreasureLevelRules[] | undefined
        )?.find((r) => r.level === box.level);
        if (!rules) {
          throw new TreasureUnlockException(
            `No frozen rules for level ${box.level} in session ${job.sessionId}.`,
          );
        }

        // ---- 2 POOL ----
        stage = TreasureUnlockStage.POOL;
        const computed = this.pool.compute(rules);
        const seed = `${box.id}:${job.correlationId}`;

        // ---- 3 ELIGIBILITY (pre-transaction: Redis round-trip) ----
        stage = TreasureUnlockStage.ELIGIBILITY;
        const cfg = loadVideoRoomTreasureConfig(this.config);
        const { eligible, candidateCount, activity, vipTiers } = await this.eligibility.resolve({
          roomId: job.roomId,
          sessionId: job.sessionId,
          rules,
          want: rules.winnerCount,
          oversampleFactor: cfg.oversampleFactor,
          oversampleMin: cfg.oversampleMin,
        });

        // ---- 4 WINNER SELECTION ----
        stage = TreasureUnlockStage.WINNER_SELECTION;
        const totals = await this.repo.contributionTotals(box.id);
        const { winners: drawn, version } = this.winners.select(rules.winnerAlgorithm, {
          eligible,
          want: rules.winnerCount,
          seed,
          contributions: new Map(totals.map((t) => [t.userId, t.amount])),
          activity,
          vipTiers,
        });
        const allocations = this.pool.allocate(computed.poolAmount, drawn);

        // ---- 5 DISTRIBUTION (one transaction) ----
        stage = TreasureUnlockStage.DISTRIBUTION;
        const outcome = await this.prisma.$transaction(async (tx) => {
          const poolRow = await this.rewards.createPool(
            {
              boxId: box.id,
              sessionId: box.sessionId,
              roomId: box.roomId,
              level: box.level,
              strategy: computed.strategy,
              sourceAmount: computed.sourceAmount,
              poolAmount: computed.poolAmount,
              winnerCount: allocations.length,
              algorithm: rules.winnerAlgorithm,
              algorithmVersion: version,
              selectionSeed: seed,
            },
            tx,
          );
          // A null pool row means another worker already minted this box.
          if (!poolRow) return null;

          await this.rewards.createWinners(
            allocations.map((a) => ({
              boxId: box.id,
              sessionId: box.sessionId,
              roomId: box.roomId,
              userId: a.userId,
              algorithm: rules.winnerAlgorithm,
              shareBps: a.shareBps,
              amount: a.amount,
              eligibleCount: eligible.length,
              candidateCount,
            })),
            tx,
          );

          await this.rewards.createPendingRewards(
            allocations.map((a, i) => ({
              sessionId: box.sessionId,
              boxId: box.id,
              roomId: box.roomId,
              level: box.level,
              userId: a.userId,
              rank: i + 1,
              coins: a.amount,
            })),
            tx,
          );

          let distributed: { userId: string; walletTxnId: string | null }[] = [];
          if (allocations.length > 0) {
            // Wallet latency is measured separately from the end-to-end unlock
            // histogram: when the 5s SLO breaks, this is what says whether the
            // wallet was the cause or merely a passenger.
            const walletStartedAt = Date.now();
            distributed = await this.distributor.distribute(
              {
                recipients: allocations.map((a, i) => ({ rank: i + 1, userId: a.userId })),
                rewards: allocations.map((a, i) => ({
                  rank: i + 1,
                  kind: 'COINS' as const,
                  coins: Number(a.amount),
                })),
                // Replaying maps to the SAME wallet transaction rather than
                // minting twice — RewardDistributor's own idempotency.
                idempotencyPrefix: `vr-treasure:${box.id}`,
                walletReason: WalletTxnReason.TREASURE_BOX,
                backpackSource: BackpackItemSource.TREASURE_BOX,
                referenceType: 'video_room_treasure_box',
                referenceId: box.id,
              },
              tx,
            );
            this.metrics.observeTreasureWalletLatency((Date.now() - walletStartedAt) / 1000);
            for (const d of distributed) {
              await this.rewards.markDistributed(box.id, d.userId, d.walletTxnId, tx);
            }
          }

          const allocated = allocations.reduce((sum, a) => sum + a.amount, 0n);
          await this.rewards.setAllocated(box.id, allocated, tx);
          await this.repo.openBox(box.id, tx);
          const nextLevel = await this.advance(tx, box, job);
          return { distributed, nextLevel };
        });

        if (!outcome) {
          this.logger.debug(`Unlock replay for box ${job.boxId} — pool already minted`);
          return { replayed: true, winners: 0, poolAmount: 0 };
        }

        // The ladder just moved and money just moved with it — drop the cached
        // status view immediately so no client sees a pre-unlock snapshot, and
        // fold this box into the live session counters.
        await this.progress.invalidateStatus(job.roomId).catch(() => undefined);
        await this.progress
          .recordUnlockStats(job.roomId, job.sessionId, {
            minted: Number(computed.poolAmount),
            winners: allocations.length,
          })
          .catch(() => undefined);

        // ---- 6/7/8 BROADCAST + AUDIT (post-commit) ----
        stage = TreasureUnlockStage.BROADCAST;
        await this.publish(
          job,
          box,
          computed,
          rules,
          version,
          eligible.length,
          candidateCount,
          allocations,
          outcome.distributed,
          outcome.nextLevel,
        );

        // ---- 9 CHAIN ----
        stage = TreasureUnlockStage.CHAIN;
        await this.chain(job, box);

        return {
          replayed: false,
          winners: allocations.length,
          poolAmount: Number(computed.poolAmount),
        };
      } catch (err) {
        const message = (err as Error).message;
        await this.rewards.markFailed(job.boxId, stage, message).catch(() => undefined);
        await this.bus
          .publish(
            new TreasureUnlockFailedEvent({
              correlationId: job.correlationId,
              roomId: job.roomId,
              sessionId: job.sessionId,
              boxId: job.boxId,
              level: job.level,
              stage,
              attempt,
              error: message,
            }),
          )
          .catch(() => undefined);
        // Rethrow so BullMQ retries and ultimately dead-letters the job.
        throw err;
      }
    });
  }

  /** Promote the next box, or complete the ladder when this was the last one. */
  private async advance(
    tx: Prisma.TransactionClient,
    box: TreasureBox,
    job: VideoRoomTreasureUnlockJob,
  ): Promise<number | null> {
    const boxes = await this.repo.listBoxes(box.sessionId, tx);
    const next = boxes.find((b) => b.level === box.level + 1);
    if (!next) {
      await this.repo.transitionSession(
        job.sessionId,
        UNLOCKABLE,
        TreasureSessionStatus.COMPLETED,
        tx,
      );
      return null;
    }
    await this.repo.setSessionLevel(job.sessionId, next.level, tx);
    await this.repo.activateBox(next.id, tx);
    return next.level;
  }

  /**
   * Step 9 — the ONLY enqueue path after the first job. If a combo gift already
   * filled the next box, claim it and queue it. Chaining rather than fanning out
   * is what keeps a four-level combo paying out in level order instead of racing
   * four concurrent animations.
   */
  private async chain(job: VideoRoomTreasureUnlockJob, box: TreasureBox): Promise<void> {
    const boxes = await this.repo.listBoxes(box.sessionId);
    const next = boxes.find((b) => b.level === box.level + 1);
    if (!next || next.progress < next.threshold) return;
    if (!(await this.repo.claimUnlock(next.id))) return;

    await this.queue.enqueue<VideoRoomTreasureUnlockJob>(
      QUEUE_NAMES.GIFT_PROCESSING,
      VIDEO_ROOM_TREASURE_QUEUE_JOB,
      {
        roomId: job.roomId,
        sessionId: job.sessionId,
        boxId: next.id,
        level: next.level,
        // Same correlationId: the whole combo reads back as one causal chain.
        correlationId: job.correlationId,
      },
      { jobId: `treasure-unlock:${next.id}`, attempts: 5 },
    );
  }

  private async publish(
    job: VideoRoomTreasureUnlockJob,
    box: TreasureBox,
    computed: { strategy: string; sourceAmount: bigint; poolAmount: bigint },
    rules: TreasureLevelRules,
    version: number,
    eligibleCount: number,
    candidateCount: number,
    allocations: PoolAllocation[],
    distributed: { userId: string; walletTxnId: string | null }[],
    nextLevel: number | null,
  ): Promise<void> {
    const base = {
      correlationId: job.correlationId,
      roomId: job.roomId,
      sessionId: job.sessionId,
      boxId: box.id,
      level: box.level,
    };
    const winnerPayload = allocations.map((a) => ({
      userId: a.userId,
      amount: Number(a.amount),
      shareBps: a.shareBps,
    }));

    await this.bus.publish(
      new TreasureRewardGeneratedEvent({
        ...base,
        strategy: computed.strategy,
        poolAmount: Number(computed.poolAmount),
        sourceAmount: Number(computed.sourceAmount),
        winnerCount: allocations.length,
      }),
    );
    await this.bus.publish(
      new TreasureWinnerSelectedEvent({
        ...base,
        algorithm: rules.winnerAlgorithm,
        algorithmVersion: version,
        eligibleCount,
        candidateCount,
        winners: winnerPayload,
      }),
    );
    for (const d of distributed) {
      const alloc = allocations.find((a) => a.userId === d.userId);
      await this.bus.publish(
        new TreasureRewardDistributedEvent({
          ...base,
          userId: d.userId,
          amount: Number(alloc?.amount ?? 0n),
          walletTxnId: d.walletTxnId,
        }),
      );
    }
    await this.bus.publish(
      new TreasureUnlockedEvent({
        ...base,
        poolAmount: Number(computed.poolAmount),
        winners: winnerPayload,
        algorithm: rules.winnerAlgorithm,
        nextLevel,
      }),
    );
  }
}
