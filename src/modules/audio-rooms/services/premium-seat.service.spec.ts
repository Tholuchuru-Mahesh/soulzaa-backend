import { ConfigService } from '@nestjs/config';
import { IEventBus } from 'src/common/events';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import type { IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomSeatsRepository } from '../repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { PremiumSeatRepository } from '../repositories/premium-seat.repository';
import { RoomPermissionService } from './room-permission.service';
import { PremiumSeatService } from './premium-seat.service';

const BUYER: RoomActor = { id: 'buyer-1', roles: ['USER'] };
const ROOM = 'room-1';

describe('PremiumSeatService', () => {
  let repo: Record<string, jest.Mock>;
  let seats: Record<string, jest.Mock>;
  let rooms: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let config: { get: jest.Mock };
  let locks: { withLock: jest.Mock };
  let queue: { enqueue: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let wallet: Record<string, jest.Mock>;
  let service: PremiumSeatService;

  beforeEach(() => {
    repo = {
      findActive: jest.fn().mockResolvedValue(null),
      countActive: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({
        id: 'seat-1',
        roomId: ROOM,
        userId: BUYER.id,
        price: 50000n,
        status: 'ACTIVE',
        purchasedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      }),
      finish: jest.fn().mockResolvedValue(undefined),
      listActive: jest.fn().mockResolvedValue([]),
      listUserSeats: jest.fn().mockResolvedValue([[], 0]),
    };
    seats = {
      getRole: jest.fn().mockResolvedValue({ role: 'ADMIN' }),
      upsertRole: jest.fn().mockResolvedValue(undefined),
      deleteRole: jest.fn().mockResolvedValue(undefined),
    };
    rooms = {
      findLiveRoomRow: jest.fn().mockResolvedValue({ id: ROOM }),
      getMember: jest.fn().mockResolvedValue({ isActive: true }),
      getOwnerId: jest.fn().mockResolvedValue('owner-x'),
      getSettings: jest.fn().mockResolvedValue({ premiumAdminSeatCount: 2 }),
    };
    permissions = { assertCanModerate: jest.fn().mockResolvedValue(undefined) };
    config = {
      get: jest.fn().mockReturnValue({ premiumSeat: { priceGold: 50000, durationDays: 30 } }),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    wallet = {
      debit: jest
        .fn()
        .mockResolvedValue({ transactionId: 'w1', balanceAfter: 0, duplicate: false }),
      credit: jest
        .fn()
        .mockResolvedValue({ transactionId: 'w2', balanceAfter: 50000, duplicate: false }),
    };
    service = new PremiumSeatService(
      repo as unknown as PremiumSeatRepository,
      seats as unknown as AudioRoomSeatsRepository,
      rooms as unknown as AudioRoomsRepository,
      permissions as unknown as RoomPermissionService,
      config as unknown as ConfigService,
      locks as unknown as LockService,
      queue as unknown as QueueService,
      bus,
      wallet as unknown as IWalletService,
    );
  });

  describe('purchase', () => {
    it('debits gold, grants PREMIUM_ADMIN, records the seat and broadcasts', async () => {
      await service.purchase(BUYER, ROOM);
      expect(wallet.debit).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 50000, reason: 'PREMIUM_SEAT' }),
      );
      expect(seats.upsertRole).toHaveBeenCalledWith(ROOM, BUYER.id, 'PREMIUM_ADMIN', BUYER.id);
      expect(repo.create).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.premium_seat_granted' }),
      );
    });

    it('rejects when no premium seats are available', async () => {
      rooms.getSettings.mockResolvedValue({ premiumAdminSeatCount: 0 });
      await expect(service.purchase(BUYER, ROOM)).rejects.toMatchObject({
        errorCode: 'PREMIUM_SEAT_UNAVAILABLE',
      });
    });

    it('rejects when the buyer already holds a premium seat', async () => {
      repo.findActive.mockResolvedValue({ id: 'existing' });
      await expect(service.purchase(BUYER, ROOM)).rejects.toMatchObject({
        errorCode: 'PREMIUM_SEAT_ALREADY_HELD',
      });
    });

    it('rejects a non-admin user', async () => {
      seats.getRole.mockResolvedValue(null);
      await expect(service.purchase(BUYER, ROOM)).rejects.toMatchObject({
        errorCode: 'NOT_ROOM_ADMIN',
      });
    });

    it('rejects an existing premium admin', async () => {
      seats.getRole.mockResolvedValue({ role: 'PREMIUM_ADMIN' });
      await expect(service.purchase(BUYER, ROOM)).rejects.toMatchObject({
        errorCode: 'PREMIUM_SEAT_ALREADY_HELD',
      });
    });

    it('rejects the room owner', async () => {
      rooms.getOwnerId.mockResolvedValue(BUYER.id);
      await expect(service.purchase(BUYER, ROOM)).rejects.toMatchObject({
        errorCode: 'ALREADY_ELEVATED',
      });
    });

    it('refunds when the grant fails', async () => {
      seats.upsertRole.mockRejectedValue(new Error('db down'));
      await expect(service.purchase(BUYER, ROOM)).rejects.toBeInstanceOf(Error);
      expect(wallet.credit).toHaveBeenCalledWith(expect.objectContaining({ amount: 50000 }));
    });
  });

  describe('expire', () => {
    it('strips the PREMIUM_ADMIN role and flips status + broadcasts', async () => {
      seats.getRole.mockResolvedValue({ role: 'PREMIUM_ADMIN' });
      await service.expire({ id: 'seat-1', roomId: ROOM, userId: BUYER.id } as never);
      expect(seats.deleteRole).toHaveBeenCalledWith(ROOM, BUYER.id);
      expect(repo.finish).toHaveBeenCalledWith('seat-1', 'EXPIRED', null);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.premium_seat_ended' }),
      );
    });
  });
});
