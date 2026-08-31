import { Inject, Injectable } from '@nestjs/common';
import {
  BackpackItemSource,
  RocketEvent,
  RocketStatus,
  TreasureRewardKind,
  WalletTxnReason,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  rocketLockKey,
  rocketRoomLockKey,
  type RewardEntry,
} from '../constants/treasure.constants';
import {
  RocketCompletedEvent,
  RocketProgressEvent,
  RocketStartedEvent,
  type RewardSummary,
} from '../events/treasure.events';
import { RocketRepository } from '../repositories/rocket.repository';
import { RewardDistributor } from './reward-distributor.service';

/**
 * Rocket events (AR-6): a premium "trigger" gift starts a timed rocket in the
 * room; every trigger-gift send during the window adds to the contribution
 * total. When the timer expires the expiry monitor completes the rocket, ranks
 * contributors, distributes the configured reward pool (coins→wallet, items→
 * backpack), and broadcasts the celebration. Contributions and rewards are
 * immutable ledger rows.
 */
@Injectable()
export class RocketService {
  constructor(
    private readonly repo: RocketRepository,
    private readonly distributor: RewardDistributor,
    private readonly locks: LockService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  /** Called for each AUDIO_ROOM gift; starts/feeds a rocket if the gift triggers one. */
  async maybeTrigger(input: {
    roomId: string;
    giftId: string;
    senderId: string;
    giftValue: number;
    giftTxnId: string | null;
  }): Promise<void> {
    const config = await this.repo.getConfigByGift(input.giftId);
    if (!config || !config.enabled) return;

    await this.locks.withLock(rocketRoomLockKey(input.roomId), async () => {
      let active = await this.repo.getActiveByRoom(input.roomId);
      if (!active) {
        const endsAt = new Date(Date.now() + config.durationSeconds * 1000);
        active = await this.repo.createEvent({
          roomId: input.roomId,
          contextType: 'AUDIO_ROOM',
          triggerGiftId: input.giftId,
          triggeredBy: input.senderId,
          endsAt,
        });
        await this.bus.publish(
          new RocketStartedEvent({
            roomId: input.roomId,
            rocketId: active.id,
            triggerGiftId: input.giftId,
            triggeredBy: input.senderId,
            endsAt: endsAt.toISOString(),
          }),
        );
      }

      await this.repo.addContribution({
        rocketId: active.id,
        roomId: input.roomId,
        userId: input.senderId,
        amount: BigInt(input.giftValue),
        giftTxnId: input.giftTxnId,
      });
      const updated = await this.repo.addProgress(active.id, BigInt(input.giftValue));
      await this.bus.publish(
        new RocketProgressEvent({
          roomId: input.roomId,
          rocketId: active.id,
          totalContribution: Number(updated.totalContribution),
        }),
      );
    });
  }

  /** Complete an expired rocket: rank → distribute pool → broadcast. */
  async complete(rocketId: string): Promise<void> {
    await this.locks.withLock(rocketLockKey(rocketId), async () => {
      const rocket = await this.repo.getEvent(rocketId);
      if (!rocket || rocket.status !== RocketStatus.ACTIVE) return;

      const totals = await this.repo.topContributors(rocketId, 3);
      const config = await this.repo.getConfigByGift(rocket.triggerGiftId);
      const rewardPool = (config?.rewardPool as unknown as RewardEntry[]) ?? [];

      const distributed = await this.distributor.distribute({
        recipients: totals.map((t, i) => ({ rank: i + 1, userId: t.userId })),
        rewards: rewardPool,
        idempotencyPrefix: `rocket:${rocketId}`,
        walletReason: WalletTxnReason.EVENT_REWARD,
        backpackSource: BackpackItemSource.ROCKET,
        referenceType: 'rocket',
        referenceId: rocketId,
      });
      for (const d of distributed) {
        await this.repo.createReward({
          rocketId,
          roomId: rocket.roomId,
          userId: d.userId,
          rank: d.rank,
          kind: d.kind,
          coins: d.coins,
          itemType: d.itemType,
          itemName: d.itemName,
          walletTxnId: d.walletTxnId,
          backpackItemId: d.backpackItemId,
        });
      }

      await this.repo.complete(rocketId);
      await this.bus.publish(
        new RocketCompletedEvent({
          roomId: rocket.roomId,
          rocketId,
          totalContribution: Number(rocket.totalContribution),
          rewards: this.rewardSummaries(distributed),
        }),
      );
      await this.queue.enqueue(QUEUE_NAMES.ANALYTICS_PROCESSING, 'rocket.completed', {
        rocketId,
        roomId: rocket.roomId,
        totalContribution: Number(rocket.totalContribution),
      });
    });
  }

  /** Expiry sweep: complete every rocket whose timer has elapsed. */
  async completeExpired(now: Date): Promise<void> {
    const expired = await this.repo.findExpired(now);
    for (const rocket of expired) await this.complete(rocket.id);
  }

  async history(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listEvents(roomId, q.skip, q.limit);
    return buildPaginated(
      rows.map((r) => this.eventView(r)),
      total,
      q.page,
      q.limit,
    );
  }

  // ---- Internals ----

  private rewardSummaries(
    distributed: {
      userId: string;
      rank: number;
      kind: TreasureRewardKind;
      coins: bigint | null;
      itemName: string | null;
      itemType?: string | null;
      itemRefId?: string | null;
      mediaUrl?: string | null;
      thumbnailUrl?: string | null;
      expiresAt?: Date | null;
    }[],
  ): RewardSummary[] {
    return distributed.map((d) => ({
      userId: d.userId,
      rank: d.rank,
      kind: d.kind,
      coins: d.coins !== null ? Number(d.coins) : null,
      itemName: d.itemName,
      itemType: d.itemType ?? null,
      itemRefId: d.itemRefId ?? null,
      mediaUrl: d.mediaUrl ?? null,
      thumbnailUrl: d.thumbnailUrl ?? null,
      expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
    }));
  }

  private eventView(r: RocketEvent) {
    return {
      id: r.id,
      triggerGiftId: r.triggerGiftId,
      triggeredBy: r.triggeredBy,
      status: r.status,
      totalContribution: Number(r.totalContribution),
      startedAt: r.startedAt,
      endsAt: r.endsAt,
      completedAt: r.completedAt,
    };
  }
}
