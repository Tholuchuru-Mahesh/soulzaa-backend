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
    const session = await this.autoStartTodaySession(roomId);
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

  // ---- Session lifecycle & Auto-Start ----

  /**
   * Ensures a valid Treasure Session exists for today.
   * - If a session created TODAY exists and is ACTIVE: returns it (same-day rejoin, progress continues).
   * - If an active session is from a PREVIOUS day: auto-completes it and starts a fresh session for today (Daily Reset).
   * - If all 5 boxes for today were completed: returns null.
   */
  async autoStartTodaySession(roomId: string, ownerId?: string): Promise<TreasureSession | null> {
    return this.locks.withLock(treasureRoomLockKey(roomId), async () => {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);

      let session = await this.repo.getActiveSession(roomId);
      if (session) {
        if (session.createdAt >= todayStart) {
          // Session was created today -> continue seamlessly!
          return session;
        }
        // Session was created on a previous day -> auto-finish it for daily reset
        await this.repo.finishSession(session.id, TreasureSessionStatus.COMPLETED);
        session = null;
      }

      // Check if session was already completed TODAY
      const completedToday = await this.repo.getLatestCompletedSessionCreatedAfter(
        roomId,
        todayStart,
      );
      if (completedToday) {
        return null; // All 5 boxes for today completed
      }

      // Auto-create today's session!
      const roomOwnerId = await this.rooms.getOwnerId(roomId).catch(() => null);
      const effectiveOwnerId = ownerId ?? roomOwnerId ?? 'system';

      const configs = await this.repo.listEnabledConfigs();
      const byLevel = new Map(configs.map((c) => [c.level, c]));
      if (byLevel.size < TREASURE_BOX_COUNT) {
        this.logger.warn(
          `Cannot auto-start treasure session for room ${roomId}: configs incomplete`,
        );
        return null;
      }

      await this.cache.del(treasureChampionsCacheKey(roomId));

      const newSession = await this.repo.createSession(roomId, effectiveOwnerId, 'AUDIO_ROOM');
      for (let level = 1; level <= TREASURE_BOX_COUNT; level++) {
        const cfg = byLevel.get(level)!;
        await this.repo.createBox({
          sessionId: newSession.id,
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
          sessionId: newSession.id,
          currentLevel: 1,
          threshold: firstThreshold,
        }),
      );
      await this.bus.publish(
        new TreasureProgressEvent({
          roomId,
          sessionId: newSession.id,
          level: 1,
          progress: 0,
          threshold: firstThreshold,
          topGifters: [],
        }),
      );
      return newSession;
    });
  }

  async startSession(actor: RoomActor, roomId: string): Promise<TreasureSession> {
    await this.assertManager(roomId, actor);
    if (!(await this.rooms.isRoomLive(roomId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    // Validate configuration BEFORE delegating. `autoStartTodaySession` returns
    // null for two unrelated reasons — the ladder is misconfigured, or today's
    // boxes are already done — and collapsing both into TREASURE_SESSION_EXISTS
    // tells an operator who forgot to seed a level that a session is active.
    // That is a configuration fault, so it gets its own code and a 424.
    const configs = await this.repo.listEnabledConfigs();
    if (new Set(configs.map((c) => c.level)).size < TREASURE_BOX_COUNT) {
      throw new BusinessException(
        ERROR_CODES.TREASURE_CONFIG_INCOMPLETE,
        `All ${TREASURE_BOX_COUNT} treasure box levels must be configured before starting a session.`,
        HttpStatus.FAILED_DEPENDENCY,
      );
    }

    const session = await this.autoStartTodaySession(roomId, actor.id);
    if (!session) {
      throw new BusinessException(
        ERROR_CODES.TREASURE_SESSION_EXISTS,
        'All treasure boxes for today are already completed or a session is active.',
        HttpStatus.CONFLICT,
      );
    }
    return session;
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
    const postCommitFns: (() => Promise<void>)[] = [];

    // Idempotency check: if this gift transaction has already contributed to treasure box, skip duplicate processing
    if (giftTxnId) {
      const existingTx = await tx.treasureContribution.findFirst({
        where: { giftTxnId },
      });
      if (existingTx) {
        this.logger.log(`Treasure: skipping duplicate contribution for giftTxnId ${giftTxnId}`);
        return { acceptedAmount: 0, refundAmount: 0, events: [] };
      }
    }

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    // 1. Find active session or auto-create today's session inside transaction
    let session = await tx.treasureSession.findFirst({
      where: { roomId, status: TreasureSessionStatus.ACTIVE },
    });

    if (session && session.createdAt < todayStart) {
      // Session from previous day -> finish it for daily reset (history preserved)
      await tx.treasureSession.update({
        where: { id: session.id },
        data: { status: TreasureSessionStatus.COMPLETED, completedAt: new Date() },
      });
      session = null;
    }

    if (!session) {
      // Check if session completed today
      const completedToday = await tx.treasureSession.findFirst({
        where: { roomId, status: TreasureSessionStatus.COMPLETED, createdAt: { gte: todayStart } },
      });

      if (!completedToday) {
        // Auto-start today's session inside transaction!
        const configs = await tx.treasureBoxConfig.findMany({
          where: { enabled: true },
          orderBy: { level: 'asc' },
        });

        if (configs.length >= TREASURE_BOX_COUNT) {
          const byLevel = new Map(configs.map((c) => [c.level, c]));
          session = await tx.treasureSession.create({
            data: { roomId, startedBy: senderId, contextType: 'AUDIO_ROOM' },
          });

          for (let level = 1; level <= TREASURE_BOX_COUNT; level++) {
            const cfg = byLevel.get(level)!;
            await tx.treasureBox.create({
              data: {
                sessionId: session.id,
                roomId,
                level,
                threshold: cfg.threshold,
                status: level === 1 ? TreasureBoxStatus.ACTIVE : TreasureBoxStatus.PENDING,
              },
            });
          }

          const firstThreshold = Number(byLevel.get(1)!.threshold);
          events.push(
            new TreasureSessionStartedEvent({
              roomId,
              sessionId: session.id,
              currentLevel: 1,
              threshold: firstThreshold,
            }),
          );
        }
      }
    }

    // 2. Increment overall contribution counters in DB using tx client
    const roomTotal = await this.repo.incrementRoomContribution(roomId, bigAmount, tx);
    const receiverTotal = await this.repo.incrementUserContribution(receiverId, bigAmount, tx);

    postCommitFns.push(async () => {
      const roomRedisKey = `room:contribution_counter:${roomId}`;
      const userRedisKey = `user:contribution_counter:${receiverId}`;
      // Sync Redis to the DB total so the counter survives server restarts.
      await this.cache.set(roomRedisKey, Number(roomTotal));
      await this.cache.set(userRedisKey, Number(receiverTotal));
    });

    events.push(
      new ContributionCounterUpdatedEvent({
        roomId,
        receiverId,
        roomTotal: Number(roomTotal),
        receiverTotal: Number(receiverTotal),
      }),
    );

    if (!session) {
      // If today's 5 boxes were already completed, normal gift processed with 0 refund
      return {
        acceptedAmount: amount,
        refundAmount: 0,
        events,
        postCommit: async () => {
          for (const fn of postCommitFns) await fn();
        },
      };
    }

    // 3. Process sequential multi-box progress, carry-forward, and overflow refund inside tx
    let remainingAmount = bigAmount;
    let acceptedAmount = 0n;
    let refundAmount = 0n;

    while (remainingAmount > 0n) {
      const freshSession = await tx.treasureSession.findUnique({
        where: { id: session.id },
      });

      if (!freshSession || freshSession.status !== TreasureSessionStatus.ACTIVE) {
        refundAmount += remainingAmount;
        remainingAmount = 0n;
        break;
      }

      const currentBox = await tx.treasureBox.findUnique({
        where: {
          sessionId_level: {
            sessionId: freshSession.id,
            level: freshSession.currentLevel,
          },
        },
      });

      if (!currentBox || currentBox.status !== TreasureBoxStatus.ACTIVE) {
        refundAmount += remainingAmount;
        remainingAmount = 0n;
        break;
      }

      const needed = currentBox.threshold - currentBox.progress;
      if (needed <= 0n) {
        // Box is already full!
        if (currentBox.level >= TREASURE_BOX_COUNT) {
          refundAmount += remainingAmount;
          remainingAmount = 0n;
          break;
        } else {
          // Advance to next box level
          await tx.treasureSession.update({
            where: { id: freshSession.id },
            data: { currentLevel: freshSession.currentLevel + 1 },
          });
          await tx.treasureBox.update({
            where: {
              sessionId_level: {
                sessionId: freshSession.id,
                level: freshSession.currentLevel + 1,
              },
            },
            data: { status: TreasureBoxStatus.ACTIVE },
          });
          continue;
        }
      }

      const added = remainingAmount >= needed ? needed : remainingAmount;
      acceptedAmount += added;
      remainingAmount -= added;

      // Immutable contribution record
      await tx.treasureContribution.create({
        data: {
          boxId: currentBox.id,
          sessionId: freshSession.id,
          roomId,
          userId: senderId,
          amount: added,
          giftTxnId,
        },
      });

      // Increment box progress
      const updatedBox = await tx.treasureBox.update({
        where: { id: currentBox.id },
        data: { progress: { increment: added } },
      });

      // Calculate current Top 3 gifters for this box
      const topGroup = await tx.treasureContribution.groupBy({
        by: ['userId'],
        where: { boxId: currentBox.id },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 3,
      });

      const topGifters: RankedContributor[] = topGroup.map((g, idx) => ({
        rank: idx + 1,
        userId: g.userId,
        amount: Number(g._sum.amount ?? 0n),
      }));

      events.push(
        new TreasureProgressEvent({
          roomId,
          sessionId: freshSession.id,
          level: currentBox.level,
          progress: Number(updatedBox.progress),
          threshold: Number(updatedBox.threshold),
          topGifters,
        }),
      );

      // Box Completion check!
      if (updatedBox.progress >= updatedBox.threshold) {
        // Mark OPENED and snapshot Top 3 gifters into box JSON
        await tx.treasureBox.update({
          where: { id: currentBox.id },
          data: {
            status: TreasureBoxStatus.OPENED,
            topGifters: topGifters as any,
            openedAt: new Date(),
          },
        });

        // Distribute rewards using existing RewardDistributor
        const cfg = await tx.treasureBoxConfig.findUnique({
          where: { level: currentBox.level },
        });
        const rewardEntries = (cfg?.rewards as unknown as RewardEntry[]) ?? [];

        const distributed = await this.distributor.distribute(
          {
            recipients: topGifters.map((g) => ({ rank: g.rank, userId: g.userId })),
            rewards: rewardEntries,
            idempotencyPrefix: `treasure:${currentBox.id}`,
            walletReason: WalletTxnReason.TREASURE_BOX,
            backpackSource: BackpackItemSource.TREASURE_BOX,
            referenceType: 'treasure_box',
            referenceId: currentBox.id,
          },
          tx,
        );

        for (const d of distributed) {
          await tx.treasureReward.create({
            data: {
              sessionId: freshSession.id,
              boxId: currentBox.id,
              roomId,
              level: currentBox.level,
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

        const summaries: RewardSummary[] = this.rewardSummaries(distributed);

        events.push(
          new TreasureBoxOpenedEvent({
            roomId,
            sessionId: freshSession.id,
            level: currentBox.level,
            topGifters,
            rewards: summaries,
            nextLevel: currentBox.level >= TREASURE_BOX_COUNT ? null : currentBox.level + 1,
          }),
        );

        if (currentBox.level >= TREASURE_BOX_COUNT) {
          // Box 5 finished -> complete session
          await tx.treasureSession.update({
            where: { id: freshSession.id },
            data: { status: TreasureSessionStatus.COMPLETED, completedAt: new Date() },
          });

          events.push(
            new TreasureSessionCompletedEvent({
              roomId,
              sessionId: freshSession.id,
            }),
          );

          if (remainingAmount > 0n) {
            refundAmount += remainingAmount;
            remainingAmount = 0n;
          }
          break;
        } else {
          // Advance to next box level!
          const nextLevel = currentBox.level + 1;
          await tx.treasureSession.update({
            where: { id: freshSession.id },
            data: { currentLevel: nextLevel },
          });
          const nextBox = await tx.treasureBox.update({
            where: {
              sessionId_level: {
                sessionId: freshSession.id,
                level: nextLevel,
              },
            },
            data: { status: TreasureBoxStatus.ACTIVE },
          });

          events.push(
            new TreasureProgressEvent({
              roomId,
              sessionId: freshSession.id,
              level: nextLevel,
              progress: Number(nextBox.progress),
              threshold: Number(nextBox.threshold),
              topGifters: [],
            }),
          );
        }
      }
    }

    return {
      acceptedAmount: Number(acceptedAmount),
      refundAmount: Number(refundAmount),
      events,
      postCommit: async () => {
        for (const fn of postCommitFns) await fn();
      },
      level: session.currentLevel,
    };
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
    // Sync Redis to the DB total so the counter survives server restarts.
    await this.cache.set(roomRedisKey, Number(roomTotal));
    await this.cache.set(userRedisKey, Number(receiverTotal));

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
    const session = await this.autoStartTodaySession(roomId);
    if (!session) {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const completedToday = await this.repo.getLatestCompletedSessionCreatedAfter(
        roomId,
        todayStart,
      );
      if (completedToday) {
        const boxes = await this.repo.listBoxes(completedToday.id);
        return {
          active: true,
          completedAll: true,
          sessionId: completedToday.id,
          currentLevel: 5,
          boxes: await Promise.all(boxes.map((b) => this.boxView(b))),
        };
      }
      return { active: false };
    }
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
      if (
        box.status === TreasureBoxStatus.OPENED &&
        box.topGifters &&
        (box.topGifters as any[]).length > 0
      ) {
        for (const g of box.topGifters as any[]) {
          if (g.userId) userIdsSet.add(g.userId);
        }
      } else {
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
        let gifters = (box.topGifters as any[]) ?? [];
        if (gifters.length === 0) {
          const totals = await this.repo.topContributors(box.id, 3);
          gifters = totals.map((t, i) => ({
            rank: i + 1,
            userId: t.userId,
            amount: Number(t.amount),
          }));
        }
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
            amount: Number(g.amount ?? 0),
            rewardLabel,
          };
        });
        if (currentUserId) {
          const userPos = await this.repo.getUserPositionInBox(box.id, currentUserId);
          if (userPos) myPosition = { rank: userPos.rank, amount: Number(userPos.amount) };
        }
      } else {
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
          if (userPos) myPosition = { rank: userPos.rank, amount: Number(userPos.amount) };
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
