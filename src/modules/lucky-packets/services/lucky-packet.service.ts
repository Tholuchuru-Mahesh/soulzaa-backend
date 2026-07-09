import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  LuckyPacket,
  LuckyPacketStatus,
  Prisma,
  RoomMemberRole,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { LockService } from 'src/infra/redis/lock.service';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
} from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { computeClaimAmount, luckyPacketLockKey } from '../constants/lucky-packet.constants';
import { CreateLuckyPacketDto } from '../dto/lucky-packet.dto';
import {
  LuckyPacketClaimedEvent,
  LuckyPacketCompletedEvent,
  LuckyPacketCreatedEvent,
  LuckyPacketExpiredEvent,
} from '../events/lucky-packet.events';
import type {
  ActiveLuckyPacket,
  ILuckyPacketsService,
} from '../interfaces/lucky-packets.service.interface';
import { LuckyPacketRepository } from '../repositories/lucky-packet.repository';

const MANAGER_ROLES: ReadonlySet<RoomMemberRole> = new Set([
  RoomMemberRole.OWNER,
  RoomMemberRole.ADMIN,
  RoomMemberRole.PREMIUM_ADMIN,
]);

/**
 * Lucky packets (AR-14): a room host funds a coin packet (debited from their
 * wallet) with N winner slots and a claim window. Members claim slots and are
 * credited a server-computed share (RANDOM or FIXED). Every claim is idempotent
 * on a deterministic `(packet, user)` wallet key and guarded by a per-packet
 * lock + a DB unique constraint, so a slot can never be double-credited or
 * over-drawn. Unclaimed coins are refunded to the creator on expiry. All coin
 * movement flows through WALLET_SERVICE; realtime fan-out flows through
 * EVENT_BUS → the audio-rooms lucky-packet socket bridge.
 */
@Injectable()
export class LuckyPacketService implements ILuckyPacketsService {
  private readonly logger = new Logger(LuckyPacketService.name);

  constructor(
    private readonly repo: LuckyPacketRepository,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(AUDIO_ROOMS_SERVICE) private readonly rooms: IAudioRoomsService,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
  ) {}

  // ---- ILuckyPacketsService ----

  async getActivePackets(roomId: string): Promise<ActiveLuckyPacket[]> {
    const packets = await this.repo.findActiveByRoom(roomId);
    return Promise.all(packets.map((p) => this.toActive(p)));
  }

  // ---- Create ----

  async create(actor: RoomActor, roomId: string, dto: CreateLuckyPacketDto): Promise<unknown> {
    await this.assertManager(roomId, actor);
    if (!(await this.rooms.isRoomLive(roomId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    if (dto.totalCoins < dto.winnerCount) {
      throw new BusinessException(
        ERROR_CODES.LUCKY_PACKET_INVALID_PARAMS,
        'Total coins must be at least the number of winners.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const currency = dto.currency ?? WalletCurrency.GOLD;
    // Deterministic key: a retried create with the same client key never double-debits.
    const idempotencyKey = dto.idempotencyKey
      ? `lucky:create:${actor.id}:${dto.idempotencyKey}`
      : `lucky:create:${actor.id}:${roomId}:${dto.totalCoins}:${dto.winnerCount}:${Date.now()}`;

    const debit = await this.wallet.debit({
      userId: actor.id,
      currency,
      amount: dto.totalCoins,
      reason: WalletTxnReason.LUCKY_PACKET_CREATE,
      idempotencyKey,
      referenceType: 'lucky_packet',
      metadata: { roomId, winnerCount: dto.winnerCount, distribution: dto.distribution },
    });

    const expiresAt = new Date(Date.now() + dto.expiresInSeconds * 1000);
    const packet = await this.repo.create({
      roomId,
      creatorId: actor.id,
      currency,
      totalCoins: BigInt(dto.totalCoins),
      winnerCount: dto.winnerCount,
      distribution: dto.distribution,
      message: dto.message ?? null,
      debitTxnId: debit.transactionId,
      expiresAt,
    });

    await this.bus.publish(
      new LuckyPacketCreatedEvent({
        roomId,
        packetId: packet.id,
        creatorId: actor.id,
        currency,
        totalCoins: dto.totalCoins,
        winnerCount: dto.winnerCount,
        distribution: dto.distribution,
        message: packet.message,
        expiresAt: expiresAt.toISOString(),
        createdAt: packet.createdAt.toISOString(),
      }),
    );

    return this.packetView(packet, 0);
  }

  // ---- Claim (money-critical) ----

  async claim(actor: RoomActor, roomId: string, packetId: string): Promise<unknown> {
    await this.rooms.assertMember(roomId, actor.id);

    return this.locks.withLock(luckyPacketLockKey(packetId), async () => {
      const packet = await this.repo.findById(packetId);
      if (!packet || packet.roomId !== roomId) {
        throw new BusinessException(
          ERROR_CODES.LUCKY_PACKET_NOT_FOUND,
          'Lucky packet not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (
        packet.status === LuckyPacketStatus.EXPIRED ||
        packet.status === LuckyPacketStatus.REFUNDED
      ) {
        throw new BusinessException(
          ERROR_CODES.LUCKY_PACKET_EXPIRED,
          'This lucky packet has expired.',
          HttpStatus.CONFLICT,
        );
      }
      if (packet.status !== LuckyPacketStatus.ACTIVE || packet.remainingSlots <= 0) {
        throw new BusinessException(
          ERROR_CODES.LUCKY_PACKET_EXHAUSTED,
          'This lucky packet has been fully claimed.',
          HttpStatus.CONFLICT,
        );
      }
      if (packet.expiresAt.getTime() <= Date.now()) {
        throw new BusinessException(
          ERROR_CODES.LUCKY_PACKET_EXPIRED,
          'This lucky packet has expired.',
          HttpStatus.CONFLICT,
        );
      }

      const amount = computeClaimAmount({
        distribution: packet.distribution,
        totalCoins: Number(packet.totalCoins),
        winnerCount: packet.winnerCount,
        remainingCoins: Number(packet.remainingCoins),
        remainingSlots: packet.remainingSlots,
      });
      const complete = packet.remainingSlots <= 1;

      let applied;
      try {
        applied = await this.repo.applyClaim({
          packetId,
          roomId,
          userId: actor.id,
          amount: BigInt(amount),
          complete,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BusinessException(
            ERROR_CODES.LUCKY_PACKET_ALREADY_CLAIMED,
            'You have already claimed this lucky packet.',
            HttpStatus.CONFLICT,
          );
        }
        throw err;
      }

      // Deterministic per-(packet,user) key → a retried/replayed claim never double-credits.
      const credit = await this.wallet.credit({
        userId: actor.id,
        currency: packet.currency,
        amount,
        reason: WalletTxnReason.LUCKY_PACKET_CLAIM,
        idempotencyKey: `lucky:claim:${packetId}:${actor.id}`,
        referenceType: 'lucky_packet',
        referenceId: packetId,
        metadata: { roomId },
      });
      await this.repo.setClaimTxn(applied.claim.id, credit.transactionId);

      const claimedCount = packet.winnerCount - applied.packet.remainingSlots;
      await this.bus.publish(
        new LuckyPacketClaimedEvent({
          roomId,
          packetId,
          userId: actor.id,
          amount,
          claimedCount,
          winnerCount: packet.winnerCount,
          remainingCoins: Number(applied.packet.remainingCoins),
          remainingSlots: applied.packet.remainingSlots,
        }),
      );
      if (applied.packet.status === LuckyPacketStatus.COMPLETED) {
        await this.bus.publish(new LuckyPacketCompletedEvent({ roomId, packetId, claimedCount }));
      }

      return {
        packetId,
        amount,
        currency: packet.currency,
        balanceAfter: credit.balanceAfter,
        remainingSlots: applied.packet.remainingSlots,
        remainingCoins: Number(applied.packet.remainingCoins),
        completed: applied.packet.status === LuckyPacketStatus.COMPLETED,
      };
    });
  }

  // ---- Reads ----

  async getPacket(roomId: string, packetId: string): Promise<unknown> {
    const packet = await this.repo.findById(packetId);
    if (!packet || packet.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.LUCKY_PACKET_NOT_FOUND,
        'Lucky packet not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const claimedCount = await this.repo.countClaims(packetId);
    return this.packetView(packet, claimedCount);
  }

  async getActive(roomId: string): Promise<unknown> {
    const active = await this.getActivePackets(roomId);
    return { active };
  }

  async listClaims(
    roomId: string,
    packetId: string,
    q: { skip: number; limit: number; page: number; search?: string },
  ): Promise<Paginated<unknown>> {
    const packet = await this.repo.findById(packetId);
    if (!packet || packet.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.LUCKY_PACKET_NOT_FOUND,
        'Lucky packet not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const [rows, total] = await this.repo.listClaims(packetId, q.skip, q.limit, q.search?.trim());
    return buildPaginated(
      rows.map((c) => ({
        id: c.id,
        userId: c.userId,
        amount: Number(c.amount),
        createdAt: c.createdAt,
      })),
      total,
      q.page,
      q.limit,
    );
  }

  async history(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listHistory(roomId, q.skip, q.limit);
    return buildPaginated(
      rows.map((p) => this.packetView(p, p.winnerCount - p.remainingSlots)),
      total,
      q.page,
      q.limit,
    );
  }

  // ---- Expiry (called by the monitor) ----

  async refundExpired(now: Date): Promise<void> {
    const expired = await this.repo.findExpired(now, 50);
    for (const packet of expired) {
      await this.locks.withLock(luckyPacketLockKey(packet.id), async () => {
        const fresh = await this.repo.findById(packet.id);
        if (!fresh || fresh.status !== LuckyPacketStatus.ACTIVE) return;
        if (fresh.expiresAt.getTime() > Date.now()) return;

        const remaining = Number(fresh.remainingCoins);
        const claimedCount = fresh.winnerCount - fresh.remainingSlots;

        if (remaining > 0) {
          await this.wallet.credit({
            userId: fresh.creatorId,
            currency: fresh.currency,
            amount: remaining,
            reason: WalletTxnReason.LUCKY_PACKET_REFUND,
            idempotencyKey: `lucky:refund:${fresh.id}`,
            referenceType: 'lucky_packet',
            referenceId: fresh.id,
            metadata: { roomId: fresh.roomId },
          });
        }
        await this.repo.markStatus(
          fresh.id,
          remaining > 0 ? LuckyPacketStatus.REFUNDED : LuckyPacketStatus.EXPIRED,
        );
        await this.bus.publish(
          new LuckyPacketExpiredEvent({
            roomId: fresh.roomId,
            packetId: fresh.id,
            refundedCoins: remaining,
            claimedCount,
          }),
        );
      });
    }
  }

  // ---- Internals ----

  private async toActive(p: LuckyPacket): Promise<ActiveLuckyPacket> {
    const claimedCount = p.winnerCount - p.remainingSlots;
    return {
      packetId: p.id,
      roomId: p.roomId,
      creatorId: p.creatorId,
      totalCoins: Number(p.totalCoins),
      winnerCount: p.winnerCount,
      remainingCoins: Number(p.remainingCoins),
      remainingSlots: p.remainingSlots,
      claimedCount,
      expiresAt: p.expiresAt,
    };
  }

  private packetView(p: LuckyPacket, claimedCount: number) {
    return {
      id: p.id,
      roomId: p.roomId,
      creatorId: p.creatorId,
      currency: p.currency,
      totalCoins: Number(p.totalCoins),
      winnerCount: p.winnerCount,
      distribution: p.distribution,
      message: p.message,
      status: p.status,
      remainingCoins: Number(p.remainingCoins),
      remainingSlots: p.remainingSlots,
      claimedCount,
      expiresAt: p.expiresAt,
      completedAt: p.completedAt,
      createdAt: p.createdAt,
    };
  }

  private async assertManager(roomId: string, actor: RoomActor): Promise<void> {
    const role = await this.rooms.getEffectiveRole(roomId, actor.id);
    if (!role || !MANAGER_ROLES.has(role)) {
      throw new BusinessException(
        ERROR_CODES.LUCKY_PACKET_NOT_AUTHORIZED,
        'Only the room owner or an admin can create a lucky packet.',
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
