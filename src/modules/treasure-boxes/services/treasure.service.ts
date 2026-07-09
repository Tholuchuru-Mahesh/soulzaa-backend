import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  BackpackItemSource,
  Prisma,
  RoomMemberRole,
  TreasureBox,
  TreasureBoxStatus,
  TreasureRewardKind,
  TreasureSession,
  TreasureSessionStatus,
  WalletTxnReason,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
} from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import {
  TREASURE_BOX_COUNT,
  treasureRoomLockKey,
  treasureSessionLockKey,
  type RewardEntry,
} from '../constants/treasure.constants';
import {
  TreasureBoxOpenedEvent,
  TreasureProgressEvent,
  TreasureSessionCompletedEvent,
  TreasureSessionStartedEvent,
  type RankedContributor,
  type RewardSummary,
} from '../events/treasure.events';
import type {
  ActiveTreasureSession,
  ITreasureBoxesService,
} from '../interfaces/treasure-boxes.service.interface';
import { TreasureRepository } from '../repositories/treasure.repository';
import { RewardDistributor } from './reward-distributor.service';

const MANAGER_ROLES: ReadonlySet<RoomMemberRole> = new Set([
  RoomMemberRole.OWNER,
  RoomMemberRole.ADMIN,
  RoomMemberRole.PREMIUM_ADMIN,
]);

/**
 * Treasure boxes (AR-6): a room owner/admin starts a session of 5 sequential
 * boxes; gift contributions (fed from GiftSentEvent) accumulate into the current
 * box; when a box reaches its configured threshold it auto-opens, computes its
 * OWN Top-3 gifters, distributes that box's rewards (coins→wallet, items→
 * backpack), snapshots the winners, resets and advances to the next box, and
 * broadcasts progress/opening/announcement events. The 5th box completes the
 * session. Every contribution and reward is an immutable ledger row.
 */
@Injectable()
export class TreasureService implements ITreasureBoxesService {
  constructor(
    private readonly repo: TreasureRepository,
    private readonly distributor: RewardDistributor,
    private readonly locks: LockService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(AUDIO_ROOMS_SERVICE) private readonly rooms: IAudioRoomsService,
  ) {}

  // ---- ITreasureBoxesService ----

  async getActiveSession(roomId: string): Promise<ActiveTreasureSession | null> {
    const session = await this.repo.getActiveSession(roomId);
    if (!session) return null;
    const box = await this.repo.getBoxByLevel(session.id, session.currentLevel);
    return {
      sessionId: session.id,
      roomId,
      currentLevel: session.currentLevel,
      progress: Number(box?.progress ?? 0n),
      threshold: Number(box?.threshold ?? 0n),
    };
  }

  // ---- Session lifecycle ----

  async startSession(actor: RoomActor, roomId: string): Promise<TreasureSession> {
    await this.assertManager(roomId, actor);
    if (!(await this.rooms.isRoomLive(roomId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }

    const configs = await this.repo.listEnabledConfigs();
    const byLevel = new Map(configs.map((c) => [c.level, c]));
    for (let level = 1; level <= TREASURE_BOX_COUNT; level++) {
      if (!byLevel.has(level)) {
        throw new BusinessException(
          ERROR_CODES.TREASURE_CONFIG_INCOMPLETE,
          `Treasure box level ${level} is not configured.`,
          HttpStatus.CONFLICT,
        );
      }
    }

    return this.locks.withLock(treasureRoomLockKey(roomId), async () => {
      if (await this.repo.getActiveSession(roomId)) {
        throw new BusinessException(
          ERROR_CODES.TREASURE_SESSION_EXISTS,
          'A treasure session is already active in this room.',
          HttpStatus.CONFLICT,
        );
      }
      const session = await this.repo.createSession(roomId, actor.id, 'AUDIO_ROOM');
      for (let level = 1; level <= TREASURE_BOX_COUNT; level++) {
        const cfg = byLevel.get(level)!;
        await this.repo.createBox({
          sessionId: session.id,
          roomId,
          level,
          threshold: cfg.threshold,
          status: level === 1 ? TreasureBoxStatus.ACTIVE : TreasureBoxStatus.PENDING,
        });
      }
      const firstThreshold = Number(byLevel.get(1)!.threshold);
      await this.bus.publish(
        new TreasureSessionStartedEvent({
          roomId,
          sessionId: session.id,
          currentLevel: 1,
          threshold: firstThreshold,
        }),
      );
      return session;
    });
  }

  async cancelSession(actor: RoomActor, roomId: string): Promise<void> {
    await this.assertManager(roomId, actor);
    const session = await this.repo.getActiveSession(roomId);
    if (!session) {
      throw new BusinessException(
        ERROR_CODES.TREASURE_SESSION_NOT_FOUND,
        'No active treasure session.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.repo.finishSession(session.id, TreasureSessionStatus.CANCELLED);
    await this.bus.publish(new TreasureSessionCompletedEvent({ roomId, sessionId: session.id }));
  }

  // ---- Contribution (driven by GiftSentEvent) ----

  async handleContribution(
    roomId: string,
    userId: string,
    amount: number,
    giftTxnId: string | null,
  ): Promise<void> {
    const session = await this.repo.getActiveSession(roomId);
    if (!session) return;

    await this.locks.withLock(treasureSessionLockKey(session.id), async () => {
      // Re-read under the lock — another gift may have advanced/closed the session.
      const fresh = await this.repo.getSession(session.id);
      if (!fresh || fresh.status !== TreasureSessionStatus.ACTIVE) return;
      const box = await this.repo.getBoxByLevel(fresh.id, fresh.currentLevel);
      if (!box || box.status !== TreasureBoxStatus.ACTIVE) return;

      await this.repo.addContribution({
        boxId: box.id,
        sessionId: fresh.id,
        roomId,
        userId,
        amount: BigInt(amount),
        giftTxnId,
      });
      const updated = await this.repo.addProgress(box.id, BigInt(amount));

      await this.bus.publish(
        new TreasureProgressEvent({
          roomId,
          sessionId: fresh.id,
          level: box.level,
          progress: Number(updated.progress),
          threshold: Number(updated.threshold),
        }),
      );

      if (updated.progress >= updated.threshold) {
        await this.openAndAdvance(fresh, updated);
      }
    });
  }

  // ---- Reads ----

  async status(roomId: string): Promise<unknown> {
    const session = await this.repo.getActiveSession(roomId);
    if (!session) return { active: false };
    const boxes = await this.repo.listBoxes(session.id);
    return {
      active: true,
      sessionId: session.id,
      currentLevel: session.currentLevel,
      boxes: boxes.map((b) => this.boxView(b)),
    };
  }

  async history(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listSessions(roomId, q.skip, q.limit);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async rewards(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listRewards(roomId, q.skip, q.limit);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  // ---- Internals ----

  /** Open the current box: Top-3 → distribute → snapshot → reset/advance. */
  private async openAndAdvance(session: TreasureSession, box: TreasureBox): Promise<void> {
    const totals = await this.repo.topContributors(box.id, 3);
    const topGifters: RankedContributor[] = totals.map((t, i) => ({
      rank: i + 1,
      userId: t.userId,
      amount: Number(t.amount),
    }));

    const cfg = await this.repo.getConfig(box.level);
    const rewards = (cfg?.rewards as unknown as RewardEntry[]) ?? [];
    const distributed = await this.distributor.distribute({
      recipients: topGifters.map((g) => ({ rank: g.rank, userId: g.userId })),
      rewards,
      idempotencyPrefix: `treasure:${box.id}`,
      walletReason: WalletTxnReason.TREASURE_BOX,
      backpackSource: BackpackItemSource.TREASURE_BOX,
      referenceType: 'treasure_box',
      referenceId: box.id,
    });
    for (const d of distributed) {
      await this.repo.createReward({
        sessionId: session.id,
        boxId: box.id,
        roomId: box.roomId,
        level: box.level,
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

    await this.repo.openBox(box.id, topGifters as unknown as Prisma.InputJsonValue);

    const nextLevel = box.level + 1;
    const completed = nextLevel > TREASURE_BOX_COUNT;
    if (!completed) {
      await this.repo.setSessionLevel(session.id, nextLevel);
      const nextBox = await this.repo.getBoxByLevel(session.id, nextLevel);
      if (nextBox) await this.repo.activateBox(nextBox.id);
    } else {
      await this.repo.finishSession(session.id, TreasureSessionStatus.COMPLETED);
    }

    await this.bus.publish(
      new TreasureBoxOpenedEvent({
        roomId: box.roomId,
        sessionId: session.id,
        level: box.level,
        topGifters,
        rewards: this.rewardSummaries(distributed),
        nextLevel: completed ? null : nextLevel,
      }),
    );
    await this.queue.enqueue(QUEUE_NAMES.ANALYTICS_PROCESSING, 'treasure.box_opened', {
      sessionId: session.id,
      boxId: box.id,
      level: box.level,
      roomId: box.roomId,
    });

    if (completed) {
      await this.bus.publish(
        new TreasureSessionCompletedEvent({ roomId: box.roomId, sessionId: session.id }),
      );
    } else {
      // Announce the next box starting fresh (progress reset to 0).
      const nextBox = await this.repo.getBoxByLevel(session.id, nextLevel);
      if (nextBox) {
        await this.bus.publish(
          new TreasureProgressEvent({
            roomId: box.roomId,
            sessionId: session.id,
            level: nextLevel,
            progress: 0,
            threshold: Number(nextBox.threshold),
          }),
        );
      }
    }
  }

  private rewardSummaries(
    distributed: {
      userId: string;
      rank: number;
      kind: TreasureRewardKind;
      coins: bigint | null;
      itemName: string | null;
    }[],
  ): RewardSummary[] {
    return distributed.map((d) => ({
      userId: d.userId,
      rank: d.rank,
      kind: d.kind,
      coins: d.coins !== null ? Number(d.coins) : null,
      itemName: d.itemName,
    }));
  }

  private boxView(b: TreasureBox) {
    return {
      level: b.level,
      status: b.status,
      progress: Number(b.progress),
      threshold: Number(b.threshold),
      topGifters: b.topGifters,
      openedAt: b.openedAt,
    };
  }

  private async assertManager(roomId: string, actor: RoomActor): Promise<void> {
    const role = await this.rooms.getEffectiveRole(roomId, actor.id);
    if (!role || !MANAGER_ROLES.has(role)) {
      throw new BusinessException(
        ERROR_CODES.TREASURE_NOT_AUTHORIZED,
        'Only the room owner or an admin can manage treasure boxes.',
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
