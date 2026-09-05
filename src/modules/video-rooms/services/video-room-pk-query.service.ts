import { Inject, Injectable } from '@nestjs/common';
import {
  VideoRoomPkBattle,
  VideoRoomPkMode,
  VideoRoomPkParticipant,
  VideoRoomPkStatus,
  VideoRoomPkTeam,
} from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { REDIS_CLIENT, type RedisClient } from 'src/infra/redis/redis.constants';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { isPkTerminal, pkScoreKey } from '../constants/video-room-pk.constants';
import {
  PKHistoryQueryDto,
  PKParticipantView,
  PKResponseDto,
  PKScoreDto,
  PKStatisticsDto,
} from '../dto/video-room-pk.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';

/** One row of `GET /pk/history` — the terminal-only, lightweight past-battle view. */
export interface PkHistoryView {
  id: string;
  mode: VideoRoomPkMode;
  status: VideoRoomPkStatus;
  isDraw: boolean;
  winningTeamId: string | null;
  startedAt: string | null;
  endsAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/**
 * The CQRS read side for VR-12 (Task 21): current battle, history,
 * statistics. Reads only — never mutates, never enqueues — so the Task 22
 * controller can call it freely with no lifecycle side effects. Mirrors the
 * VR-11 `VideoRoomTreasureQueryService` conventions.
 *
 * Every BigInt is converted to a Number here, at the DTO boundary, so no
 * BigInt ever reaches `JSON.stringify` (which throws on it in production).
 *
 * **The Redis-mirror gap.** Nothing in the PK engine writes a per-room
 * late-join state key: Task 13's scoring `mirror()` only writes
 * `pkScoreKey(battleId)` (its payload carries no roomId), and no lifecycle
 * command writes a state key either (Task 21 deliberately resolves late-join
 * reads from Postgres instead — there is no such key to read). So
 * `getCurrent` treats `pkScoreKey(battleId)` as an OPTIONAL accelerator for
 * live TEAM scores only — read after Postgres has already resolved the
 * battle id — and derives status/timing/participants from Postgres
 * unconditionally. A cold or faulted mirror degrades to the Postgres value,
 * never to stale/empty data.
 */
@Injectable()
export class VideoRoomPkQueryService {
  constructor(
    private readonly repo: VideoRoomPkRepository,
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  /**
   * The current (non-terminal) battle in the room, or `{ active: false }`.
   * `serverTime` is stamped on every response — active or not — so a
   * late-joining client can correct its own clock skew against the
   * countdown/`endsAt` fields rather than trusting its own clock, which is
   * exactly the failure mode that makes two clients' countdowns visibly
   * disagree.
   */
  async getCurrent(roomId: string): Promise<PKResponseDto> {
    const battle = await this.repo.findCurrent(roomId);
    if (!battle) {
      return { active: false, serverTime: new Date().toISOString() };
    }

    const [teams, participants, mirror] = await Promise.all([
      this.repo.listTeams(battle.id),
      this.repo.listParticipants(battle.id),
      this.readScoreMirror(battle.id),
    ]);

    const teamViews = teams.map((t) => this.teamView(t, mirror));
    const participantViews = participants.map((p) => this.participantView(p));
    const redScore = teamViews.find((t) => t.side === 'RED')?.score ?? 0;
    const blueScore = teamViews.find((t) => t.side === 'BLUE')?.score ?? 0;
    const challenger = participantViews.find((p) => p.side === 'BLUE');

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
      teams: teamViews,
      redScore,
      blueScore,
      challengerUserId: challenger?.userId,
      participants: participantViews,
    };
  }

  /**
   * Terminal battles only, paginated. The exclusion is enforced twice: the
   * repository's WHERE clause already scopes to terminal statuses (so
   * `total` and the fetched page agree), and this filters again defensively
   * — a live battle must never appear in "past battles" even if the
   * repository query regresses.
   */
  async history(
    _actor: RoomActor,
    roomId: string,
    q: PKHistoryQueryDto,
  ): Promise<Paginated<PkHistoryView>> {
    const skip = (q.page - 1) * q.limit;
    const [rows, total] = await this.repo.listBattles(roomId, skip, q.limit);
    const terminal = rows.filter((b) => isPkTerminal(b.status));
    return buildPaginated(
      terminal.map((b) => this.historyView(b)),
      total,
      q.page,
      q.limit,
    );
  }

  /**
   * Room-wide, all-time battle/contribution totals. Gated on
   * `VIEW_ANALYTICS` — a different, stronger permission than the plain room
   * access `getCurrent`/`history` need — mirroring how VR-11's
   * `VideoRoomTreasureQueryService.statistics` gates its own endpoint: skip
   * the check only when the room itself cannot be resolved, since there is
   * then nothing to authorize against and the aggregate is empty anyway.
   */
  async statistics(actor: RoomActor, roomId: string): Promise<PKStatisticsDto> {
    const room = await this.rooms.findById(roomId);
    if (room) {
      await this.permissions.assertPermission(
        actor,
        { id: room.id, ownerId: room.ownerId },
        VideoRoomPermission.VIEW_ANALYTICS,
      );
    }

    const stats = await this.repo.statistics(roomId);
    return {
      totalBattles: stats.totalBattles,
      totalWins: stats.totalWins,
      totalDraws: stats.totalDraws,
      totalContributed: Number(stats.totalContributed),
      totalGiftCount: stats.totalGiftCount,
    };
  }

  /**
   * Best-effort read of the live scoreboard HASH Task 13's `mirror()` writes
   * (`{ RED, BLUE, giftCount, baseTotal }`). Returns `null` on a cold key
   * (`hgetall` on a missing key resolves to `{}`, not an error) or on any
   * Redis fault — both cases fall back to the Postgres score already loaded
   * by the caller, never to a thrown error or stale data.
   */
  private async readScoreMirror(battleId: string): Promise<Record<string, string> | null> {
    try {
      const hash = await this.redis.hgetall(pkScoreKey(battleId));
      return hash && Object.keys(hash).length > 0 ? hash : null;
    } catch {
      return null;
    }
  }

  private teamView(team: VideoRoomPkTeam, mirror: Record<string, string> | null): PKScoreDto {
    const mirrored = mirror?.[team.side];
    return {
      teamId: team.id,
      side: team.side,
      score: mirrored !== undefined ? Number(mirrored) : Number(team.score),
    };
  }

  private participantView(p: VideoRoomPkParticipant): PKParticipantView {
    return {
      userId: p.userId,
      teamId: p.teamId,
      side: p.side,
      score: Number(p.score),
      giftCount: p.giftCount,
    };
  }

  private historyView(battle: VideoRoomPkBattle): PkHistoryView {
    return {
      id: battle.id,
      mode: battle.mode,
      status: battle.status,
      isDraw: battle.isDraw,
      winningTeamId: battle.winningTeamId,
      startedAt: battle.startedAt ? battle.startedAt.toISOString() : null,
      endsAt: battle.endsAt ? battle.endsAt.toISOString() : null,
      completedAt: battle.completedAt ? battle.completedAt.toISOString() : null,
      cancelledAt: battle.cancelledAt ? battle.cancelledAt.toISOString() : null,
      createdAt: battle.createdAt.toISOString(),
    };
  }
}
