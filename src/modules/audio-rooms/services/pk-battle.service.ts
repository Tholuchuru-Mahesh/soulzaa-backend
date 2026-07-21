import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  BackpackItemSource,
  CosmeticRarity,
  CosmeticType,
  PkBattle,
  PkResult,
  PkSide,
  PkStatus,
  RoomMemberRole,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  PK_WINNER_BADGE_NAME,
  PK_WINS_LEADERBOARD_KEY,
  pkBattleLockKey,
  pkRoomLockKey,
} from '../constants/pk.constants';
import {
  PkCancelledEvent,
  PkEndedEvent,
  PkScoreEvent,
  PkStartedEvent,
  PkInvitedEvent,
  PkRejectedEvent,
} from '../events/audio-room-pk.events';
import { InvitePkDto, StartPkDto } from '../dto/pk.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { PkBattleRepository } from '../repositories/pk-battle.repository';
import { RoomPermissionService } from './room-permission.service';

const MANAGER_ROLES: ReadonlySet<RoomMemberRole> = new Set([
  RoomMemberRole.OWNER,
  RoomMemberRole.ADMIN,
  RoomMemberRole.PREMIUM_ADMIN,
]);

/**
 * PK Battles (AR-10): 1v1 and Team gift-score battles in an audio room. The
 * owner/admin starts a battle assigning participants to RED/BLUE; gifts sent to
 * a participant while the timer runs add to their side's live score. At expiry
 * the higher side wins, winners receive a badge (backpack) + a PK-wins ranking
 * point, and the match is recorded. Contributions and rewards are immutable.
 */
@Injectable()
export class PkBattleService {
  private badgeCosmeticId: string | null = null;

  constructor(
    private readonly repo: PkBattleRepository,
    private readonly rooms: AudioRoomsRepository,
    private readonly permissions: RoomPermissionService,
    private readonly locks: LockService,
    private readonly cache: CacheService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
  ) {}

  // ======================= Start =======================

  async start(actor: RoomActor, roomId: string, dto: StartPkDto): Promise<unknown> {
    await this.assertManager(roomId, actor);
    if (!(await this.rooms.findLiveRoomRow(roomId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    this.validateParticipants(dto);
    for (const userId of [...dto.red, ...dto.blue]) {
      const member = await this.rooms.getMember(roomId, userId);
      if (!member?.isActive) {
        throw new BusinessException(
          ERROR_CODES.PK_PARTICIPANT_NOT_MEMBER,
          'All participants must be active members of the room.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    return this.startInternal(roomId, actor.id, dto);
  }

  async startInternal(roomId: string, startedBy: string, dto: StartPkDto): Promise<unknown> {
    return this.locks.withLock(pkRoomLockKey(roomId), async () => {
      if (await this.repo.getActive(roomId)) {
        throw new BusinessException(
          ERROR_CODES.PK_ALREADY_ACTIVE,
          'A PK battle is already running in this room.',
          HttpStatus.CONFLICT,
        );
      }
      /** 10-second client-side pre-battle countdown buffer.
       *  The mobile app shows a cinematic 3…2…1 countdown for the first 10 s
       *  before revealing the live scoreboard. Adding this offset means the
       *  actual battle duration begins exactly when the scoreboard appears,
       *  keeping both the host and audience timers perfectly in sync. */
      const PRE_BATTLE_COUNTDOWN_MS = 10_000;
      const endsAt = new Date(Date.now() + dto.durationSeconds * 1000 + PRE_BATTLE_COUNTDOWN_MS);
      const battle = await this.repo.createBattle({
        roomId,
        mode: dto.mode,
        durationSeconds: dto.durationSeconds,
        startedBy,
        endsAt,
      });
      await this.repo.createParticipants([
        ...dto.red.map((userId) => ({ battleId: battle.id, roomId, userId, side: PkSide.RED })),
        ...dto.blue.map((userId) => ({ battleId: battle.id, roomId, userId, side: PkSide.BLUE })),
      ]);
      const participants = [
        ...dto.red.map((userId) => ({ userId, side: PkSide.RED, score: 0 })),
        ...dto.blue.map((userId) => ({ userId, side: PkSide.BLUE, score: 0 })),
      ];
      await this.bus.publish(
        new PkStartedEvent({
          roomId,
          battleId: battle.id,
          mode: battle.mode,
          durationSeconds: battle.durationSeconds,
          endsAt: endsAt.toISOString(),
          participants,
        }),
      );
      return this.battleView(battle, participants);
    });
  }

  async invite(actor: RoomActor, roomId: string, dto: InvitePkDto): Promise<unknown> {
    await this.assertManager(roomId, actor);
    if (!(await this.rooms.findLiveRoomRow(roomId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    this.validateParticipants(dto);
    for (const userId of [...dto.red, ...dto.blue]) {
      const member = await this.rooms.getMember(roomId, userId);
      if (!member?.isActive) {
        throw new BusinessException(
          ERROR_CODES.PK_PARTICIPANT_NOT_MEMBER,
          'All participants must be active members of the room.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    const targetMember = await this.rooms.getMember(roomId, dto.targetUserId);
    if (!targetMember?.isActive) {
      throw new BusinessException(
        ERROR_CODES.PK_PARTICIPANT_NOT_MEMBER,
        'The target opponent must be active in the room.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Cache the invitation details in Redis (30 seconds TTL)
    const cacheKey = `pk-invite:${roomId}`;
    await this.cache.set(cacheKey, { dto, inviterId: actor.id }, 30);

    // Fetch the inviter's name
    const inviterUser = await this.users.findById(actor.id);
    const inviterName = inviterUser?.username || 'Owner';

    // Broadcast pk.invited event to room
    await this.bus.publish(
      new PkInvitedEvent({
        roomId,
        mode: dto.mode,
        durationSeconds: dto.durationSeconds,
        red: dto.red,
        blue: dto.blue,
        targetUserId: dto.targetUserId,
        inviterId: actor.id,
        inviterName,
      }),
    );

    return { invited: true };
  }

  async acceptInvite(userId: string, roomId: string): Promise<unknown> {
    const cacheKey = `pk-invite:${roomId}`;
    const cached = await this.cache.get<{ dto: StartPkDto; inviterId: string }>(cacheKey);
    if (!cached) {
      throw new BusinessException(
        ERROR_CODES.PK_NOT_FOUND,
        'The PK battle invitation has expired or does not exist.',
        HttpStatus.GONE,
      );
    }
    await this.cache.del(cacheKey);

    // Run core start logic using the cached invitation payload
    return this.startInternal(roomId, cached.inviterId, cached.dto);
  }

  async rejectInvite(userId: string, roomId: string): Promise<void> {
    const cacheKey = `pk-invite:${roomId}`;
    const cached = await this.cache.get<{ dto: StartPkDto; inviterId: string }>(cacheKey);
    if (!cached) return;
    await this.cache.del(cacheKey);

    // Broadcast pk.rejected event
    await this.bus.publish(
      new PkRejectedEvent({
        roomId,
        targetUserId: userId,
        inviterId: cached.inviterId,
      }),
    );
  }

  // ======================= Score (driven by GiftSentEvent) =======================

  async handleGift(
    roomId: string,
    receiverId: string,
    amount: number,
    giftTxnId: string | null,
  ): Promise<void> {
    if (amount <= 0) return;
    const active = await this.repo.getActive(roomId);
    if (!active) return;

    await this.locks.withLock(pkBattleLockKey(active.id), async () => {
      const battle = await this.repo.getBattle(active.id);
      if (!battle || battle.status !== PkStatus.ACTIVE) return;
      const participant = await this.repo.findParticipant(battle.id, receiverId);
      if (!participant) return; // gift to a non-participant — not counted

      const updated = await this.repo.applyContribution({
        battleId: battle.id,
        roomId,
        participantId: participant.id,
        side: participant.side,
        contributorId: receiverId, // attribution: value credited to the receiver's side
        amount: BigInt(amount),
        giftTxnId,
      });
      await this.bus.publish(
        new PkScoreEvent({
          roomId,
          battleId: battle.id,
          redScore: Number(updated.redScore),
          blueScore: Number(updated.blueScore),
          side: participant.side,
          userId: receiverId,
          participantScore: Number(participant.score) + amount,
        }),
      );
    });
  }

  // ======================= Complete / cancel =======================

  async complete(battle: PkBattle): Promise<void> {
    await this.locks.withLock(pkBattleLockKey(battle.id), async () => {
      const fresh = await this.repo.getBattle(battle.id);
      if (!fresh || fresh.status !== PkStatus.ACTIVE) return;

      const result =
        fresh.redScore > fresh.blueScore
          ? PkResult.RED
          : fresh.blueScore > fresh.redScore
            ? PkResult.BLUE
            : PkResult.DRAW;
      await this.repo.complete(fresh.id, result);

      const participants = await this.repo.listParticipants(fresh.id);
      const winners: string[] = [];
      if (result !== PkResult.DRAW) {
        const winningSide = result === PkResult.RED ? PkSide.RED : PkSide.BLUE;
        const badgeId = await this.winnerBadgeId();
        for (const p of participants.filter((x) => x.side === winningSide)) {
          winners.push(p.userId);
          const grant = await this.cosmetics.grantToUser({
            userId: p.userId,
            cosmeticId: badgeId,
            source: BackpackItemSource.EVENT,
            grantKey: `pk:${fresh.id}:${p.userId}`,
          });
          await this.repo.createReward({
            battleId: fresh.id,
            roomId: fresh.roomId,
            userId: p.userId,
            side: p.side,
            cosmeticId: badgeId,
            backpackItemId: grant?.backpackItemId ?? null,
          });
          await this.cache.addScore(PK_WINS_LEADERBOARD_KEY, p.userId, 1);
        }
      }

      await this.bus.publish(
        new PkEndedEvent({
          roomId: fresh.roomId,
          battleId: fresh.id,
          result,
          redScore: Number(fresh.redScore),
          blueScore: Number(fresh.blueScore),
          winners,
        }),
      );
      await this.queue.enqueue(QUEUE_NAMES.ANALYTICS_PROCESSING, 'pk.completed', {
        battleId: fresh.id,
        roomId: fresh.roomId,
        result,
      });
    });
  }

  async completeExpired(now: Date): Promise<void> {
    const expired = await this.repo.findExpired(now);
    for (const battle of expired) await this.complete(battle);
  }

  async cancel(actor: RoomActor, roomId: string): Promise<void> {
    await this.assertManager(roomId, actor);
    const active = await this.repo.getActive(roomId);
    if (!active) {
      throw new BusinessException(
        ERROR_CODES.PK_NOT_FOUND,
        'No active PK battle.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.repo.cancel(active.id);
    await this.bus.publish(new PkCancelledEvent({ roomId, battleId: active.id }));
  }

  // ======================= Reads =======================

  async getActive(roomId: string): Promise<unknown> {
    const battle = await this.repo.getActive(roomId);
    if (!battle) return { active: false };
    const participants = await this.repo.listParticipants(battle.id);
    return {
      active: true,
      ...(this.battleView(
        battle,
        participants.map((p) => ({ userId: p.userId, side: p.side, score: Number(p.score) })),
      ) as object),
    };
  }

  async history(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listBattles(roomId, q.skip, q.limit);
    return buildPaginated(
      rows.map((b) => ({
        id: b.id,
        mode: b.mode,
        status: b.status,
        result: b.result,
        redScore: Number(b.redScore),
        blueScore: Number(b.blueScore),
        startedAt: b.startedAt,
        completedAt: b.completedAt,
      })),
      total,
      q.page,
      q.limit,
    );
  }

  async leaderboard(limit: number): Promise<unknown[]> {
    const rows = await this.cache.top(PK_WINS_LEADERBOARD_KEY, limit);
    const users = await Promise.all(rows.map((r) => this.users.findById(r.member)));
    return rows.map((r, i) => ({
      rank: i + 1,
      userId: r.member,
      username: users[i]?.username ?? null,
      wins: r.score,
    }));
  }

  // ======================= Internals =======================

  private validateParticipants(dto: StartPkDto): void {
    const overlap = dto.red.some((u) => dto.blue.includes(u));
    const dupRed = new Set(dto.red).size !== dto.red.length;
    const dupBlue = new Set(dto.blue).size !== dto.blue.length;
    const oneVsOne = dto.mode === 'ONE_VS_ONE' && (dto.red.length !== 1 || dto.blue.length !== 1);
    if (overlap || dupRed || dupBlue || oneVsOne) {
      throw new BusinessException(
        ERROR_CODES.PK_INVALID_PARTICIPANTS,
        oneVsOne
          ? 'A 1v1 battle needs exactly one participant per side.'
          : 'Participants must be distinct and not on both sides.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async winnerBadgeId(): Promise<string> {
    if (!this.badgeCosmeticId) {
      this.badgeCosmeticId = await this.cosmetics.ensureCosmetic({
        type: CosmeticType.BADGE,
        name: PK_WINNER_BADGE_NAME,
        rarity: CosmeticRarity.EPIC,
      });
    }
    return this.badgeCosmeticId;
  }

  private async assertManager(roomId: string, actor: RoomActor): Promise<void> {
    const role = await this.permissions.getEffectiveRole(roomId, actor.id);
    if (!role || !MANAGER_ROLES.has(role)) {
      throw new BusinessException(
        ERROR_CODES.PK_NOT_AUTHORIZED,
        'Only the room owner or an admin can manage PK battles.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private battleView(
    battle: PkBattle,
    participants: { userId: string; side: PkSide; score: number }[],
  ) {
    return {
      id: battle.id,
      roomId: battle.roomId,
      mode: battle.mode,
      status: battle.status,
      durationSeconds: battle.durationSeconds,
      redScore: Number(battle.redScore),
      blueScore: Number(battle.blueScore),
      result: battle.result,
      endsAt: battle.endsAt,
      participants,
    };
  }
}
