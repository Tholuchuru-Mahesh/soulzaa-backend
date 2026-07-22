import { Injectable } from '@nestjs/common';
import { TreasureBox, TreasureSessionStatus } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomTreasureRewardRepository } from '../repositories/video-room-treasure-reward.repository';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomTreasureProgressService } from './video-room-treasure-progress.service';

export interface TreasureBoxView {
  boxId: string;
  level: number;
  status: string;
  progress: number;
  threshold: number;
  remaining: number;
  percent: number;
  openedAt: string | null;
}

export interface TreasureStatusView {
  active: boolean;
  sessionId?: string;
  status?: string;
  currentLevel?: number;
  boxes?: TreasureBoxView[];
}

export interface TreasureStatisticsView {
  /** Durable all-time totals for the room, from Postgres. */
  totalPools: number;
  totalMinted: number;
  totalWinners: number;
  /**
   * Live counters for the ladder currently running, from Redis. Null when no
   * ladder is live. Cheap enough to read on every call and useful precisely
   * while a session is in flight, which is when the durable aggregate lags.
   */
  live: { boxesOpened: number; totalMinted: number; totalWinners: number } | null;
}

/**
 * The CQRS read side (VR-11 spec §7). Reads only — never mutates, never
 * enqueues — so the controller can call it freely with no lifecycle side effects.
 *
 * Every BigInt is converted to a number here, at the DTO boundary, so no BigInt
 * ever reaches JSON.stringify (which throws on it).
 */
@Injectable()
export class VideoRoomTreasureQueryService {
  constructor(
    private readonly repo: VideoRoomTreasureRepository,
    private readonly rewards: VideoRoomTreasureRewardRepository,
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly progress: VideoRoomTreasureProgressService,
  ) {}

  /**
   * The hot read. Backed by a 2-second read-through cache: `GET /treasure` is
   * polled by every client in a room, and without it a busy room turns a
   * progress bar into a sustained two-query load per viewer per poll.
   *
   * Staleness is bounded on both ends — the TTL caps a quiet miss, and the
   * progress mirror and unlock pipeline invalidate explicitly the moment the
   * ladder moves, so a payout is never hidden behind a cached snapshot.
   *
   * A Redis fault degrades to the Postgres path rather than failing the read.
   */
  async status(roomId: string): Promise<TreasureStatusView> {
    const cached = await this.progress
      .readStatusCache<TreasureStatusView>(roomId)
      .catch(() => null);
    if (cached) return cached;

    const view = await this.computeStatus(roomId);
    await this.progress.writeStatusCache(roomId, view).catch(() => undefined);
    return view;
  }

  private async computeStatus(roomId: string): Promise<TreasureStatusView> {
    const session = await this.repo.findCurrentSession(roomId);
    if (!session || session.status === TreasureSessionStatus.ARCHIVED) {
      return { active: false };
    }

    const boxes = await this.repo.listBoxes(session.id);
    return {
      active: true,
      sessionId: session.id,
      status: session.status,
      currentLevel: session.currentLevel,
      boxes: boxes.map((b) => this.boxView(b)),
    };
  }

  async history(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listSessions(roomId, q.skip, q.limit);
    return buildPaginated(
      rows.map((s) => ({
        sessionId: s.id,
        status: s.status,
        currentLevel: s.currentLevel,
        startedBy: s.startedBy,
        createdAt: s.createdAt.toISOString(),
        completedAt: s.completedAt ? s.completedAt.toISOString() : null,
      })),
      total,
      q.page,
      q.limit,
    );
  }

  async winners(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.rewards.listWinners(roomId, q.skip, q.limit);
    return buildPaginated(
      rows.map((w) => ({
        boxId: w.boxId,
        sessionId: w.sessionId,
        userId: w.userId,
        algorithm: w.algorithm,
        shareBps: w.shareBps,
        amount: Number(w.amount),
        eligibleCount: w.eligibleCount,
        candidateCount: w.candidateCount,
        selectedAt: w.selectedAt.toISOString(),
      })),
      total,
      q.page,
      q.limit,
    );
  }

  async statistics(actor: RoomActor, roomId: string): Promise<TreasureStatisticsView> {
    const room = await this.rooms.findById(roomId);
    if (room) {
      await this.permissions.assertPermission(
        actor,
        { id: room.id, ownerId: room.ownerId },
        VideoRoomPermission.VIEW_ANALYTICS,
      );
    }
    const [stats, session] = await Promise.all([
      this.rewards.statistics(roomId),
      this.repo.findCurrentSession(roomId),
    ]);

    // Redis is a convenience read here, never the source of truth — a fault
    // drops the live block rather than failing the whole endpoint.
    const live = session
      ? await this.progress.readStats(roomId, session.id).catch(() => null)
      : null;

    return {
      totalPools: stats.totalPools,
      totalMinted: Number(stats.totalMinted),
      totalWinners: stats.totalWinners,
      live,
    };
  }

  private boxView(box: TreasureBox): TreasureBoxView {
    const { progress, threshold } = box;
    // Clamp: an overfilled box (the tail of a combo gift) must not read >100%.
    const capped = progress > threshold ? threshold : progress;
    return {
      boxId: box.id,
      level: box.level,
      status: box.status,
      progress: Number(progress),
      threshold: Number(threshold),
      remaining: Number(threshold - capped),
      percent: threshold <= 0n ? 0 : Number((capped * 10_000n) / threshold) / 100,
      openedAt: box.openedAt ? box.openedAt.toISOString() : null,
    };
  }
}
