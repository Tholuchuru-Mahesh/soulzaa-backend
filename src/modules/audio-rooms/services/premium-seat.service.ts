import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PremiumAdminSeat,
  PremiumSeatStatus,
  RoomMemberRole,
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
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { premiumSeatLockKey } from '../constants/premium.constants';
import {
  PremiumSeatEndedEvent,
  PremiumSeatGrantedEvent,
} from '../events/audio-room-premium.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomSeatsRepository } from '../repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { PremiumSeatRepository } from '../repositories/premium-seat.repository';
import { RoomPermissionService } from './room-permission.service';

const _ELEVATED_ROLES: ReadonlySet<RoomMemberRole> = new Set([
  RoomMemberRole.OWNER,
  RoomMemberRole.ADMIN,
  RoomMemberRole.PREMIUM_ADMIN,
]);

/**
 * Premium Paid Admin Seat (AR-9): a room member buys the PREMIUM_ADMIN role for
 * a configurable duration with gold. The purchase debits the wallet, grants the
 * role (room_roles), and records a time-limited seat; the expiry monitor
 * auto-revokes the role when it lapses. Purchases are all-or-nothing (compensate
 * the debit if the grant fails) and serialised per (room,user).
 */
@Injectable()
export class PremiumSeatService {
  private readonly logger = new Logger(PremiumSeatService.name);

  constructor(
    private readonly repo: PremiumSeatRepository,
    private readonly seats: AudioRoomSeatsRepository,
    private readonly rooms: AudioRoomsRepository,
    private readonly permissions: RoomPermissionService,
    private readonly config: ConfigService,
    private readonly locks: LockService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
  ) {}

  async purchase(actor: RoomActor, roomId: string): Promise<unknown> {
    if (!(await this.rooms.findLiveRoomRow(roomId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    const member = await this.rooms.getMember(roomId, actor.id);
    if (!member?.isActive) {
      throw new BusinessException(
        ERROR_CODES.NOT_ROOM_MEMBER,
        'You must be in the room to buy a premium seat.',
        HttpStatus.FORBIDDEN,
      );
    }
    await this.assertEligibleForPremiumSeat(roomId, actor.id);

    const { priceGold, durationDays } = this.premiumConfig();

    return this.locks.withLock(premiumSeatLockKey(roomId, actor.id), async () => {
      if (await this.repo.findActive(roomId, actor.id)) {
        throw new BusinessException(
          ERROR_CODES.PREMIUM_SEAT_ALREADY_HELD,
          'You already hold a premium admin seat in this room.',
          HttpStatus.CONFLICT,
        );
      }
      const settings = await this.rooms.getSettings(roomId);
      const cap = settings?.premiumAdminSeatCount ?? 0;
      if (cap <= 0 || (await this.repo.countActive(roomId)) >= cap) {
        throw new BusinessException(
          ERROR_CODES.PREMIUM_SEAT_UNAVAILABLE,
          'No premium admin seats are available in this room.',
          HttpStatus.CONFLICT,
        );
      }

      const key = `premium-seat:${randomUUID()}`;
      const debit = await this.wallet.debit({
        userId: actor.id,
        currency: WalletCurrency.GOLD,
        amount: priceGold,
        reason: WalletTxnReason.PREMIUM_SEAT,
        idempotencyKey: `premium-seat-debit:${key}`,
        referenceType: 'premium_seat',
        referenceId: roomId,
      });

      try {
        await this.seats.upsertRole(roomId, actor.id, RoomMemberRole.PREMIUM_ADMIN, actor.id);
        const expiresAt = new Date(Date.now() + durationDays * 86_400_000);
        const seat = await this.repo.create({
          roomId,
          userId: actor.id,
          price: BigInt(priceGold),
          walletTxnId: debit.transactionId,
          expiresAt,
        });
        await this.bus.publish(
          new PremiumSeatGrantedEvent({
            roomId,
            userId: actor.id,
            seatId: seat.id,
            expiresAt: expiresAt.toISOString(),
          }),
        );
        await this.queue.enqueue(QUEUE_NAMES.NOTIFICATIONS, 'premium_seat.granted', {
          userId: actor.id,
          roomId,
          expiresAt: expiresAt.toISOString(),
        });
        return this.toView(seat);
      } catch (err) {
        await this.refund(actor.id, priceGold, key, roomId);
        throw err;
      }
    });
  }

  /** Expire a lapsed seat (called by the monitor): revoke role + flip status. */
  async expire(seat: PremiumAdminSeat): Promise<void> {
    await this.endSeat(seat, 'expired', null);
  }

  /** Admin/owner manual revoke (no refund — the entitlement was consumed). */
  async revoke(actor: RoomActor, roomId: string, userId: string): Promise<void> {
    await this.permissions.assertCanModerate(roomId, actor);
    const seat = await this.repo.findActive(roomId, userId);
    if (!seat) {
      throw new BusinessException(
        ERROR_CODES.PREMIUM_SEAT_NOT_FOUND,
        'That user has no active premium seat.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.endSeat(seat, 'revoked', actor.id);
  }

  async listActive(roomId: string): Promise<unknown[]> {
    const seats = await this.repo.listActive(roomId);
    return seats.map((s) => this.toView(s));
  }

  async mySeats(
    userId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listUserSeats(userId, q.skip, q.limit);
    return buildPaginated(
      rows.map((s) => this.toView(s)),
      total,
      q.page,
      q.limit,
    );
  }

  // ---- Internals ----

  private async endSeat(
    seat: PremiumAdminSeat,
    reason: 'expired' | 'revoked',
    actorId: string | null,
  ): Promise<void> {
    // Only strip the role if it is still the purchased PREMIUM_ADMIN grant.
    const role = await this.seats.getRole(seat.roomId, seat.userId);
    if (role?.role === RoomMemberRole.PREMIUM_ADMIN) {
      await this.seats.deleteRole(seat.roomId, seat.userId);
    }
    await this.repo.finish(
      seat.id,
      reason === 'expired' ? PremiumSeatStatus.EXPIRED : PremiumSeatStatus.REVOKED,
      actorId,
    );
    await this.bus.publish(
      new PremiumSeatEndedEvent({
        roomId: seat.roomId,
        userId: seat.userId,
        seatId: seat.id,
        reason,
      }),
    );
  }

  private async assertEligibleForPremiumSeat(roomId: string, userId: string): Promise<void> {
    if ((await this.rooms.getOwnerId(roomId)) === userId) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_ELEVATED,
        'The room owner already has full room privileges.',
        HttpStatus.CONFLICT,
      );
    }
    const role = await this.seats.getRole(roomId, userId);
    if (role?.role === RoomMemberRole.PREMIUM_ADMIN) {
      throw new BusinessException(
        ERROR_CODES.PREMIUM_SEAT_ALREADY_HELD,
        'You already hold a premium admin seat in this room.',
        HttpStatus.CONFLICT,
      );
    }
    if (role?.role !== RoomMemberRole.ADMIN) {
      throw new BusinessException(
        ERROR_CODES.NOT_ROOM_ADMIN,
        'Only Room Admins are eligible to purchase a premium admin seat.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async refund(userId: string, price: number, key: string, roomId: string): Promise<void> {
    try {
      await this.wallet.credit({
        userId,
        currency: WalletCurrency.GOLD,
        amount: price,
        reason: WalletTxnReason.ADMIN_CREDIT,
        idempotencyKey: `premium-seat-refund:${key}`,
        referenceType: 'premium_seat',
        referenceId: roomId,
        metadata: { refund: true, reason: 'premium_seat_purchase_failed' },
      });
    } catch (err) {
      this.logger.error(`Premium seat refund failed for key ${key}: ${(err as Error).message}`);
    }
  }

  private premiumConfig(): { priceGold: number; durationDays: number } {
    const cfg = this.config.get('audioRoom') as {
      premiumSeat: { priceGold: number; durationDays: number };
    };
    return cfg.premiumSeat;
  }

  private toView(s: PremiumAdminSeat) {
    return {
      id: s.id,
      roomId: s.roomId,
      userId: s.userId,
      price: Number(s.price),
      status: s.status,
      purchasedAt: s.purchasedAt,
      expiresAt: s.expiresAt,
    };
  }
}
