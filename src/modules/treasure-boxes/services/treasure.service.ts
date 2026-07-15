import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  BackpackItemSource,
  Prisma,
  RoomMemberRole,
  TreasureBox,
  TreasureBoxStatus,
  TreasureRewardKind,
  TreasureSession,
  TreasureSessionStatus,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
} from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import {
  TREASURE_BOX_COUNT,
  TREASURE_CHAMPIONS_CACHE_TTL,
  treasureChampionsCacheKey,
  treasureRoomLockKey,
  treasureSessionLockKey,
  type RewardEntry,
} from '../constants/treasure.constants';
import {
  TreasureBoxOpenedEvent,
  TreasureProgressEvent,
  TreasureSessionCompletedEvent,
  TreasureSessionStartedEvent,
  TreasureReceiverRewardEvent,
  ContributionCounterUpdatedEvent,
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
  private readonly logger = new Logger(TreasureService.name);

  constructor(
    private readonly repo: TreasureRepository,
    private readonly distributor: RewardDistributor,
    private readonly locks: LockService,
    private readonly cache: CacheService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(AUDIO_ROOMS_SERVICE) private readonly rooms: IAudioRoomsService,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
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
      // Clear the previous cycle's champions cache so the new cycle starts fresh.
      await this.cache.del(treasureChampionsCacheKey(roomId));

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

  async processTreasureContribution(
    tx: Prisma.TransactionClient,
    roomId: string,
    senderId: string,
    receiverId: string,
    amount: number,
    giftTxnId: string,
  ): Promise<{
    acceptedAmount: number;
    refundAmount: number;
    events: any[];
    postCommit?: () => Promise<void>;
    boxId?: string;
    level?: number;
  }> {
    const bigAmount = BigInt(amount);
    const events: any[] = [];
    let postCommitCallback: (() => Promise<void>) | undefined;

    // Find the active session
    const session = await tx.treasureSession.findFirst({
      where: { roomId, status: TreasureSessionStatus.ACTIVE },
    });

    if (!session) {
      // Check if there is a completed session in this room
      const latestCompleted = await tx.treasureSession.findFirst({
        where: { roomId, status: TreasureSessionStatus.COMPLETED },
        orderBy: { createdAt: 'desc' },
      });

      if (latestCompleted) {
        // If completed, refund everything
        return {
          acceptedAmount: 0,
          refundAmount: amount,
          events,
        };
      }

      // If no active or completed session, it's a normal gift. No refund.
      return {
        acceptedAmount: amount,
        refundAmount: 0,
        events,
      };
    }

    // Get all boxes for the session
    const boxes = await tx.treasureBox.findMany({
      where: { sessionId: session.id },
      orderBy: { level: 'asc' },
    });

    const activeBox = boxes.find((b) => b.level === session.currentLevel);

    const totalProgress = boxes.reduce((sum, b) => sum + b.progress, 0n);
    const maxCapacity = 995000n;
    const remainingCapacity = maxCapacity - totalProgress;

    if (remainingCapacity <= 0n) {
      // Completed, refund everything
      return {
        acceptedAmount: 0,
        refundAmount: amount,
        events,
      };
    }

    const accepted = bigAmount < remainingCapacity ? bigAmount : remainingCapacity;
    const refund = bigAmount - accepted;

    const acceptedNum = Number(accepted);
    const refundNum = Number(refund);

    if (accepted > 0n) {
      // Increment overall contribution counters in DB using tx client
      const roomTotal = await this.repo.incrementRoomContribution(roomId, accepted, tx);
      const receiverTotal = await this.repo.incrementUserContribution(receiverId, accepted, tx);

      // Publish Contribution Counter update event (bridges to Socket.IO)
      events.push(
        new ContributionCounterUpdatedEvent({
          roomId,
          receiverId,
          roomTotal: Number(roomTotal),
          receiverTotal: Number(receiverTotal),
        }),
      );

      // Process sequential progress overflow
      let remainingToContribute = accepted;
      let currentLevel = session.currentLevel;

      while (remainingToContribute > 0n && currentLevel <= 5) {
        const box = await tx.treasureBox.findFirst({
          where: { sessionId: session.id, level: currentLevel },
        });
        if (!box || box.status === TreasureBoxStatus.OPENED) {
          currentLevel++;
          continue;
        }

        const needed = box.threshold - box.progress;
        if (needed <= 0n) {
          currentLevel++;
          continue;
        }

        const added = remainingToContribute >= needed ? needed : remainingToContribute;

        // Record contribution
        await this.repo.addContribution({
          boxId: box.id,
          sessionId: session.id,
          roomId,
          userId: senderId,
          amount: added,
          giftTxnId,
        }, tx);

        // Update progress
        const updatedBox = await tx.treasureBox.update({
          where: { id: box.id },
          data: { progress: box.progress + added },
        });

        remainingToContribute -= added;

        // Fetch top contributors
        const totals = await this.repo.topContributors(box.id, 3, tx);
        const topGifters: RankedContributor[] = totals.map((t, i) => ({
          rank: i + 1,
          userId: t.userId,
          amount: Number(t.amount),
        }));

        events.push(
          new TreasureProgressEvent({
            roomId,
            sessionId: session.id,
            level: box.level,
            progress: Number(updatedBox.progress),
            threshold: Number(updatedBox.threshold),
            topGifters,
          }),
        );

        if (updatedBox.progress >= updatedBox.threshold) {
          const advanceRes = await this.openAndAdvanceInTx(tx, session, updatedBox, topGifters);
          events.push(...advanceRes.events);
          if (advanceRes.postCommit) {
            postCommitCallback = advanceRes.postCommit;
          }
          currentLevel++;
        }
      }
    }

    return {
      acceptedAmount: acceptedNum,
      refundAmount: refundNum,
      events,
      postCommit: postCommitCallback,
      boxId: activeBox?.id,
      level: session.currentLevel,
    };
  }

  private async openAndAdvanceInTx(
    tx: Prisma.TransactionClient,
    session: TreasureSession,
    box: TreasureBox,
    topGifters: RankedContributor[],
  ): Promise<{ events: any[]; postCommit?: () => Promise<void> }> {
    const events: any[] = [];
    let postCommit: (() => Promise<void>) | undefined;

    const cfg = await tx.treasureBoxConfig.findUnique({ where: { level: box.level } });
    const rewards = (cfg?.rewards as unknown as RewardEntry[]) ?? [];

    const distributed = await this.distributor.distribute({
      recipients: topGifters.map((g) => ({ rank: g.rank, userId: g.userId })),
      rewards,
      idempotencyPrefix: `treasure:${box.id}`,
      walletReason: WalletTxnReason.TREASURE_BOX,
      backpackSource: BackpackItemSource.TREASURE_BOX,
      referenceType: 'treasure_box',
      referenceId: box.id,
    }, tx);

    for (const d of distributed) {
      await tx.treasureReward.create({
        data: {
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
        },
      });
    }

    await tx.treasureBox.update({
      where: { id: box.id },
      data: {
        status: TreasureBoxStatus.OPENED,
        openedAt: new Date(),
        topGifters: topGifters as unknown as Prisma.InputJsonValue,
      },
    });



    const nextLevel = box.level + 1;
    const completed = nextLevel > TREASURE_BOX_COUNT;
    if (!completed) {
      await tx.treasureSession.update({
        where: { id: session.id },
        data: { currentLevel: nextLevel },
      });
      const nextBox = await tx.treasureBox.findUnique({
        where: { sessionId_level: { sessionId: session.id, level: nextLevel } },
      });
      if (nextBox) {
        await tx.treasureBox.update({
          where: { id: nextBox.id },
          data: { status: TreasureBoxStatus.ACTIVE },
        });
      }
    } else {
      await tx.treasureSession.update({
        where: { id: session.id },
        data: { status: TreasureSessionStatus.COMPLETED, completedAt: new Date() },
      });

      postCommit = async () => {
        try {
          const snapshot = await this.buildChampionsPayload(session.id, box.roomId, '');
          await this.cache.set(
            treasureChampionsCacheKey(box.roomId),
            snapshot,
            TREASURE_CHAMPIONS_CACHE_TTL,
          );
        } catch (err) {
          this.logger.warn(
            `Failed to snapshot champions cache for room ${box.roomId}: ${(err as Error).message}`,
          );
        }
      };
    }

    events.push(
      new TreasureBoxOpenedEvent({
        roomId: box.roomId,
        sessionId: session.id,
        level: box.level,
        topGifters,
        rewards: this.rewardSummaries(distributed),
        nextLevel: completed ? null : nextLevel,
      }),
    );

    if (completed) {
      events.push(
        new TreasureSessionCompletedEvent({ roomId: box.roomId, sessionId: session.id }),
      );
    }

    return { events, postCommit };
  }

  // ---- Contribution (driven by GiftSentEvent) ----

  async handleContribution(
    roomId: string,
    userId: string,
    receiverId: string,
    amount: number,
    giftTxnId: string | null,
  ): Promise<void> {
    const bigAmount = BigInt(amount);

    // 1. Increment Overall Contribution Counters (PostgreSQL + Redis)
    const roomTotal = await this.repo.incrementRoomContribution(roomId, bigAmount);
    const receiverTotal = await this.repo.incrementUserContribution(receiverId, bigAmount);

    const roomRedisKey = `room:contribution_counter:${roomId}`;
    const userRedisKey = `user:contribution_counter:${receiverId}`;
    await this.cache.increment(roomRedisKey, { by: amount });
    await this.cache.increment(userRedisKey, { by: amount });

    // Publish Contribution Counter update event (bridges to Socket.IO)
    await this.bus.publish(
      new ContributionCounterUpdatedEvent({
        roomId,
        receiverId,
        roomTotal: Number(roomTotal),
        receiverTotal: Number(receiverTotal),
      }),
    );

    // 2. Process sequential progress overflow
    const session = await this.repo.getActiveSession(roomId);
    if (!session) return;

    await this.locks.withLock(treasureSessionLockKey(session.id), async () => {
      let remainingAmount = bigAmount;

      while (remainingAmount > 0n) {
        // Re-read session state under the lock
        const fresh = await this.repo.getSession(session.id);
        if (!fresh || fresh.status !== TreasureSessionStatus.ACTIVE) break;

        const box = await this.repo.getBoxByLevel(fresh.id, fresh.currentLevel);
        if (!box || box.status !== TreasureBoxStatus.ACTIVE) break;

        const progress = box.progress;
        const threshold = box.threshold;
        const needed = threshold - progress;

        if (needed <= 0n) {
          await this.openAndAdvance(fresh, box);
          continue;
        }

        const added = remainingAmount >= needed ? needed : remainingAmount;

        await this.repo.addContribution({
          boxId: box.id,
          sessionId: fresh.id,
          roomId,
          userId,
          amount: added,
          giftTxnId,
        });

        const updated = await this.repo.addProgress(box.id, added);
        remainingAmount -= added;

        const totals = await this.repo.topContributors(box.id, 3);
        const topGifters = totals.map((t, i) => ({
          rank: i + 1,
          userId: t.userId,
          amount: Number(t.amount),
        }));

        await this.bus.publish(
          new TreasureProgressEvent({
            roomId,
            sessionId: fresh.id,
            level: box.level,
            progress: Number(updated.progress),
            threshold: Number(updated.threshold),
            topGifters,
          }),
        );

        if (updated.progress >= updated.threshold) {
          await this.openAndAdvance(fresh, updated);
        }
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
      boxes: await Promise.all(boxes.map((b) => this.boxView(b))),
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
      // Snapshot the completed champions into Redis so the data is visible
      // immediately after the session ends — without needing a DB round-trip.
      // This cache persists until the next session starts (or 25-hour TTL).
      try {
        const snapshot = await this.buildChampionsPayload(session.id, box.roomId, '');
        await this.cache.set(
          treasureChampionsCacheKey(box.roomId),
          snapshot,
          TREASURE_CHAMPIONS_CACHE_TTL,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to snapshot champions cache for room ${box.roomId}: ${(err as Error).message}`,
        );
      }
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
            topGifters: [],
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

  private async boxView(b: TreasureBox) {
    const topGifters =
      b.status === TreasureBoxStatus.OPENED
        ? ((b.topGifters as unknown as RankedContributor[]) ?? [])
        : await this.repo.topContributors(b.id, 3).then((totals) =>
            totals.map((t, i) => ({
              rank: i + 1,
              userId: t.userId,
              amount: Number(t.amount),
            })),
          );

    return {
      level: b.level,
      status: b.status,
      progress: Number(b.progress),
      threshold: Number(b.threshold),
      topGifters,
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

  async champions(roomId: string, currentUserId: string): Promise<any> {
    // For an ACTIVE session, always compute live (leaderboard changes in real-time).
    const activeSession = await this.repo.getActiveSession(roomId);
    if (activeSession) {
      return this.buildChampionsPayload(activeSession.id, roomId, currentUserId);
    }

    // For a completed session: serve from Redis cache (fast path), fall back to DB.
    const cacheKey = treasureChampionsCacheKey(roomId);
    const cached = await this.cache.get<any[]>(cacheKey);
    if (cached !== null && cached.length > 0) {
      // Re-inject the user's own position (personalised — not cached).
      return this.injectMyPosition(cached, roomId, currentUserId);
    }

    // Cache miss: compute from DB and store for subsequent calls.
    const completedSession = await this.repo.getLatestCompletedSession(roomId);
    if (!completedSession) return [];

    const result = await this.buildChampionsPayload(completedSession.id, roomId, currentUserId);
    // Cache without myPosition so it is user-agnostic (injected per-request above).
    const toCache = result.map((r: any) => ({ ...r, myPosition: null }));
    await this.cache.set(cacheKey, toCache, TREASURE_CHAMPIONS_CACHE_TTL);
    return result;
  }

  /**
   * Builds the full champions payload for a session from DB.
   * Pass an empty string for `currentUserId` when called from the snapshot
   * (no personal position needed).
   */
  private async buildChampionsPayload(
    sessionId: string,
    roomId: string,
    currentUserId: string,
  ): Promise<any[]> {
    const boxes = await this.repo.listBoxes(sessionId);
    const configs = await this.repo.listEnabledConfigs();
    const configMap = new Map(configs.map((c) => [c.level, c]));

    const userIdsSet = new Set<string>();
    if (currentUserId) userIdsSet.add(currentUserId);

    for (const box of boxes) {
      if (box.status === TreasureBoxStatus.OPENED && box.topGifters) {
        for (const g of box.topGifters as any[]) {
          if (g.userId) userIdsSet.add(g.userId);
        }
      } else if (box.status === TreasureBoxStatus.ACTIVE) {
        const totals = await this.repo.topContributors(box.id, 3);
        for (const t of totals) userIdsSet.add(t.userId);
      }
    }

    const profileMap = await this.repo.resolveUserProfiles(Array.from(userIdsSet));
    const result: any[] = [];

    for (const box of boxes) {
      const cfg = configMap.get(box.level);
      const rewardEntries = (cfg?.rewards as any[]) ?? [];

      let topGifters: any[] = [];
      let myPosition = null;

      if (box.status === TreasureBoxStatus.OPENED) {
        const gifters = (box.topGifters as any[]) ?? [];
        topGifters = gifters.map((g) => {
          const profile = profileMap.get(g.userId);
          const reward = rewardEntries.find((r) => r.rank === g.rank);
          const rewardLabel = reward
            ? reward.kind === 'BACKPACK_ITEM'
              ? reward.itemName
              : `${reward.coins} Gold`
            : null;
          return {
            rank: g.rank,
            userId: g.userId,
            username: profile?.username ?? g.userId.substring(0, 6),
            avatarUrl: profile?.avatarUrl ?? null,
            amount: g.amount,
            rewardLabel,
          };
        });
        if (currentUserId) {
          const userPos = await this.repo.getUserPositionInBox(box.id, currentUserId);
          if (userPos) myPosition = { rank: userPos.rank, amount: userPos.amount };
        }
      } else if (box.status === TreasureBoxStatus.ACTIVE) {
        const totals = await this.repo.topContributors(box.id, 3);
        topGifters = totals.map((t, i) => {
          const rank = i + 1;
          const profile = profileMap.get(t.userId);
          const reward = rewardEntries.find((r) => r.rank === rank);
          const rewardLabel = reward
            ? reward.kind === 'BACKPACK_ITEM'
              ? reward.itemName
              : `${reward.coins} Gold`
            : null;
          return {
            rank,
            userId: t.userId,
            username: profile?.username ?? t.userId.substring(0, 6),
            avatarUrl: profile?.avatarUrl ?? null,
            amount: Number(t.amount),
            rewardLabel,
          };
        });
        if (currentUserId) {
          const userPos = await this.repo.getUserPositionInBox(box.id, currentUserId);
          if (userPos) myPosition = { rank: userPos.rank, amount: userPos.amount };
        }
      }

      result.push({
        level: box.level,
        threshold: Number(box.threshold),
        status: box.status,
        topGifters,
        myPosition,
        openedAt: box.openedAt ? box.openedAt.toISOString() : null,
      });
    }

    return result;
  }

  /**
   * Takes a cached (user-agnostic) champions payload and re-injects the
   * requesting user's personal position from the DB for personalised display.
   */
  private async injectMyPosition(
    cached: any[],
    roomId: string,
    currentUserId: string,
  ): Promise<any[]> {
    if (!currentUserId) return cached;
    // Find the active session boxes (if any) to look up the user position.
    // For fully completed sessions, boxes are all OPENED — we look them up by level.
    const session = await this.repo.getLatestCompletedSession(roomId);
    if (!session) return cached;
    const boxes = await this.repo.listBoxes(session.id);
    const boxMap = new Map(boxes.map((b) => [b.level, b]));

    return Promise.all(
      cached.map(async (entry: any) => {
        const box = boxMap.get(entry.level);
        if (!box) return entry;
        const userPos = await this.repo.getUserPositionInBox(box.id, currentUserId);
        return {
          ...entry,
          myPosition: userPos ? { rank: userPos.rank, amount: userPos.amount } : null,
        };
      }),
    );
  }
}
