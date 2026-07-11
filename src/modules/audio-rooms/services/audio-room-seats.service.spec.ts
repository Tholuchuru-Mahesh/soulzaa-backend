import { ConfigService } from '@nestjs/config';
import { SeatType } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { AudioRoomSeatsRepository } from '../repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { AudioRoomSeatsService } from './audio-room-seats.service';
import { RoomPermissionService } from './room-permission.service';

import type { RoomActor } from '../interfaces/room-actor.interface';

const OWNER: RoomActor = { id: 'owner-1', roles: ['USER'] };
const LISTENER: RoomActor = { id: 'listener-1', roles: ['USER'] };

function seat(overrides: Record<string, unknown> = {}) {
  return {
    seatIndex: 1,
    seatType: SeatType.SPEAKER,
    occupantUserId: null,
    isLocked: false,
    isMuted: false,
    ...overrides,
  } as never;
}

describe('AudioRoomSeatsService', () => {
  let rooms: Record<string, jest.Mock>;
  let seats: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let locks: Record<string, jest.Mock>;
  let bus: jest.Mocked<IEventBus>;
  let service: AudioRoomSeatsService;

  beforeEach(() => {
    rooms = {
      findRoomRow: jest.fn().mockResolvedValue({ status: 'LIVE' }),
      findLiveRoomRow: jest.fn().mockResolvedValue({ status: 'LIVE' }),
      getMember: jest.fn().mockResolvedValue({ isActive: true }),
      getOwnerId: jest.fn().mockResolvedValue(OWNER.id),
      setMemberRole: jest.fn().mockResolvedValue(undefined),
    };
    seats = {
      getSeatByOccupant: jest.fn().mockResolvedValue(null),
      getSeatByIndex: jest.fn().mockResolvedValue(seat()),
      findPendingRequestByUser: jest.fn().mockResolvedValue(null),
      getRequest: jest.fn(),
      createRequest: jest.fn().mockResolvedValue({ id: 'req-1' }),
      resolveRequest: jest.fn().mockResolvedValue(undefined),
      resolveAllPendingRequestsForUser: jest.fn().mockResolvedValue(undefined),
      enqueue: jest.fn().mockResolvedValue({ position: 1 }),
      dequeue: jest.fn().mockResolvedValue(undefined),
      listSeats: jest.fn().mockResolvedValue([seat()]),
      listQueue: jest.fn().mockResolvedValue([]),
      getSettings: jest.fn().mockResolvedValue({
        requireApprovalForSeat: true,
        speakerSeatCount: 8,
        premiumAdminSeatCount: 0,
        isRoomMuted: false,
      }),
      setRequireApprovalForSeat: jest.fn().mockResolvedValue(undefined),
      setOccupant: jest.fn().mockResolvedValue(undefined),
      setSeatLocked: jest.fn().mockResolvedValue(undefined),
      setSeatMuted: jest.fn().mockResolvedValue(undefined),
      upsertRole: jest.fn().mockResolvedValue(undefined),
      getRole: jest.fn().mockResolvedValue(null),
      appendSeatHistory: jest.fn().mockResolvedValue(undefined),
      setCachedStage: jest.fn().mockResolvedValue(undefined),
      getCachedStage: jest.fn().mockResolvedValue(null),
      invalidateStage: jest.fn().mockResolvedValue(undefined),
      reconfigureLayoutTx: jest.fn().mockResolvedValue({ displaced: [] }),
    };
    permissions = {
      assertPermission: jest.fn().mockResolvedValue(undefined),
      hasPermission: jest.fn().mockResolvedValue(false),
      getEffectiveRole: jest.fn().mockResolvedValue('LISTENER'),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) as never };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    const config = {
      get: () => ({ cacheTtlSeconds: 60, seatInvitationTtlSeconds: 120 }),
    } as unknown as ConfigService;

    service = new AudioRoomSeatsService(
      rooms as unknown as AudioRoomsRepository,
      seats as unknown as AudioRoomSeatsRepository,
      permissions as unknown as RoomPermissionService,
      locks as unknown as LockService,
      config,
      bus,
    );
  });

  describe('requestSeat', () => {
    it('queues the request when approval is required', async () => {
      const res = await service.requestSeat(LISTENER, 'r', {});
      expect(res.status).toBe('queued');
      expect(res.position).toBe(1);
      expect(seats.enqueue).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.seat_requested' }),
      );
    });

    it('rejects a duplicate pending request', async () => {
      seats.findPendingRequestByUser.mockResolvedValue({ id: 'existing' });
      await expect(service.requestSeat(LISTENER, 'r', {})).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    it('auto-seats when approval is off and a seat is free', async () => {
      seats.getSettings.mockResolvedValue({
        requireApprovalForSeat: false,
        speakerSeatCount: 8,
        premiumAdminSeatCount: 0,
      });
      const res = await service.requestSeat(LISTENER, 'r', {});
      expect(res.status).toBe('seated');
      expect(seats.setOccupant).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.seat_joined' }),
      );
    });
  });

  describe('resolveRequest', () => {
    it('accepts a request and seats the user', async () => {
      seats.getRequest.mockResolvedValue({
        id: 'req-1',
        roomId: 'r',
        userId: LISTENER.id,
        status: 'PENDING',
        seatIndex: null,
      });
      await service.resolveRequest(OWNER, 'r', 'req-1', true);
      expect(seats.setOccupant).toHaveBeenCalledWith('r', 1, LISTENER.id, OWNER.id);
      expect(seats.resolveRequest).toHaveBeenCalledWith('req-1', 'ACCEPTED', OWNER.id);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.seat_accepted' }),
      );
    });

    it('rejects a request without seating', async () => {
      seats.getRequest.mockResolvedValue({
        id: 'req-1',
        roomId: 'r',
        userId: LISTENER.id,
        status: 'PENDING',
        seatIndex: null,
      });
      await service.resolveRequest(OWNER, 'r', 'req-1', false);
      expect(seats.setOccupant).not.toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.seat_rejected' }),
      );
    });

    it('enforces the manage-seats permission', async () => {
      permissions.assertPermission.mockRejectedValue(new Error('forbidden'));
      await expect(service.resolveRequest(LISTENER, 'r', 'req-1', true)).rejects.toBeDefined();
    });
  });

  describe('takeSeat', () => {
    beforeEach(() =>
      seats.getSettings.mockResolvedValue({
        requireApprovalForSeat: false,
        speakerSeatCount: 8,
        premiumAdminSeatCount: 0,
      }),
    );

    it('blocks taking a locked seat', async () => {
      seats.getSeatByIndex.mockResolvedValue(seat({ isLocked: true }));
      await expect(service.takeSeat(LISTENER, 'r', 1)).rejects.toBeInstanceOf(BusinessException);
    });

    it('blocks taking an occupied seat', async () => {
      seats.getSeatByIndex.mockResolvedValue(seat({ occupantUserId: 'someone' }));
      await expect(service.takeSeat(LISTENER, 'r', 1)).rejects.toBeInstanceOf(BusinessException);
    });

    it('forbids a non-owner taking the owner seat', async () => {
      seats.getSeatByIndex.mockResolvedValue(seat({ seatType: SeatType.OWNER, seatIndex: 0 }));
      await expect(service.takeSeat(LISTENER, 'r', 0)).rejects.toBeInstanceOf(BusinessException);
    });

    it('seats a user on an open speaker seat', async () => {
      await service.takeSeat(LISTENER, 'r', 1);
      expect(seats.setOccupant).toHaveBeenCalledWith('r', 1, LISTENER.id, LISTENER.id);
    });

    it('requires a request when approval is on and the actor cannot manage', async () => {
      seats.getSettings.mockResolvedValue({ requireApprovalForSeat: true });
      permissions.hasPermission.mockResolvedValue(false);
      await expect(service.takeSeat(LISTENER, 'r', 1)).rejects.toBeInstanceOf(BusinessException);
    });
  });

  describe('leaveSeat', () => {
    it('throws when the user is not on a seat', async () => {
      seats.getSeatByOccupant.mockResolvedValue(null);
      await expect(service.leaveSeat(LISTENER, 'r')).rejects.toBeInstanceOf(BusinessException);
    });

    it('vacates the seat and emits seat.left', async () => {
      seats.getSeatByOccupant.mockResolvedValue(seat({ occupantUserId: LISTENER.id }));
      await service.leaveSeat(LISTENER, 'r');
      expect(seats.setOccupant).toHaveBeenCalledWith('r', 1, null, LISTENER.id);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.seat_left' }),
      );
    });
  });

  describe('configureLayout', () => {
    it('rejects a layout exceeding the seat cap', async () => {
      await expect(
        service.configureLayout(OWNER, 'r', { speakerSeatCount: 20 }),
      ).rejects.toBeInstanceOf(BusinessException);
    });

    it('applies a valid layout change', async () => {
      await service.configureLayout(OWNER, 'r', { speakerSeatCount: 6, premiumAdminSeatCount: 2 });
      expect(seats.reconfigureLayoutTx).toHaveBeenCalledWith('r', 2, 6, OWNER.id);
    });
  });

  describe('grantRole', () => {
    it('grants ADMIN and syncs the member role', async () => {
      await service.grantRole(OWNER, 'r', LISTENER.id, 'ADMIN');
      expect(seats.upsertRole).toHaveBeenCalledWith('r', LISTENER.id, 'ADMIN', OWNER.id);
      expect(rooms.setMemberRole).toHaveBeenCalledWith('r', LISTENER.id, 'ADMIN', OWNER.id);
    });

    it('emits a premium-seat purchase event when granting PREMIUM_ADMIN', async () => {
      await service.grantRole(OWNER, 'r', LISTENER.id, 'PREMIUM_ADMIN');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'premium_seat.purchase_requested' }),
      );
    });
  });

  describe('setRoomMuted', () => {
    it('mutes all speaker seats and flags the room', async () => {
      seats.setRoomMuted = jest.fn().mockResolvedValue(undefined);
      seats.setSpeakerSeatsMuted = jest.fn().mockResolvedValue(undefined);
      await service.setRoomMuted(OWNER, 'r', true);
      expect(seats.setRoomMuted).toHaveBeenCalledWith('r', true);
      expect(seats.setSpeakerSeatsMuted).toHaveBeenCalledWith('r', true, OWNER.id);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.seat_updated' }),
      );
    });
  });
});
