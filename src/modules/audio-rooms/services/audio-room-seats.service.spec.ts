import { ConfigService } from '@nestjs/config';
import { SeatHistoryAction, SeatInvitationStatus, SeatRequestStatus, SeatType } from '@prisma/client';
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
const ADMIN: RoomActor = { id: 'admin-1', roles: ['USER'] };

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
      findPendingRequestsByUser: jest.fn().mockResolvedValue([]),
      getRequest: jest.fn(),
      createRequest: jest.fn().mockResolvedValue({ id: 'req-1' }),
      resolveRequest: jest.fn().mockResolvedValue(undefined),
      resolveAllPendingRequestsForUser: jest.fn().mockResolvedValue(undefined),
      clearPendingRequests: jest.fn().mockResolvedValue(undefined),
      clearAllPendingRequests: jest.fn().mockResolvedValue(undefined),
      clearSessionStateTx: jest.fn().mockResolvedValue(undefined),
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
      isRoomMuted: jest.fn().mockResolvedValue(false),
      setRoomMutedTx: jest.fn().mockResolvedValue(undefined),
      upsertRole: jest.fn().mockResolvedValue(undefined),
      getRole: jest.fn().mockResolvedValue(null),
      countAdmins: jest.fn().mockResolvedValue(0),
      appendSeatHistory: jest.fn().mockResolvedValue(undefined),
      setCachedStage: jest.fn().mockResolvedValue(undefined),
      getCachedStage: jest.fn().mockResolvedValue(null),
      invalidateStage: jest.fn().mockResolvedValue(undefined),
      reconfigureLayoutTx: jest.fn().mockResolvedValue({ displaced: [] }),
      createInvitation: jest.fn().mockResolvedValue({ id: 'inv-1' }),
      getInvitation: jest.fn(),
      getActiveInvitation: jest.fn().mockResolvedValue(null),
      resolveInvitation: jest.fn().mockResolvedValue(undefined),
    };
    permissions = {
      assertPermission: jest.fn().mockResolvedValue(undefined),
      hasPermission: jest.fn().mockResolvedValue(false),
      getEffectiveRole: jest.fn().mockResolvedValue('LISTENER'),
      assertOutranks: jest.fn().mockResolvedValue(undefined),
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

  describe('respondInvitation', () => {
    const validInvite = {
      id: 'inv-1',
      roomId: 'r',
      inviteeUserId: LISTENER.id,
      seatIndex: 1,
      status: SeatInvitationStatus.PENDING,
      expiresAt: new Date(Date.now() + 60000),
    };

    it('accepts an invitation, seats user, and leaves pending request alone if none existed', async () => {
      seats.getInvitation.mockResolvedValue(validInvite);
      seats.findPendingRequestsByUser.mockResolvedValue([]);

      await service.respondInvitation(LISTENER, 'r', 'inv-1', true);

      expect(seats.setOccupant).toHaveBeenCalledWith('r', 1, LISTENER.id, LISTENER.id);
      expect(seats.resolveInvitation).toHaveBeenCalledWith(
        'inv-1',
        SeatInvitationStatus.ACCEPTED,
        LISTENER.id,
      );
      expect(seats.resolveRequest).not.toHaveBeenCalled();
      expect(seats.dequeue).not.toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.seat_updated',
          payload: expect.objectContaining({
            reason: 'invite_accepted',
            subjectUserId: LISTENER.id,
          }),
        }),
      );
      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.seat_updated',
          payload: expect.objectContaining({
            reason: 'request_cancelled',
          }),
        }),
      );
    });

    it('accepts an invitation and atomically clears pending seat request with real-time broadcast', async () => {
      seats.getInvitation.mockResolvedValue(validInvite);
      seats.findPendingRequestsByUser.mockResolvedValue([
        {
          id: 'req-pending-1',
          roomId: 'r',
          userId: LISTENER.id,
          seatIndex: 2,
          status: SeatRequestStatus.PENDING,
        },
      ]);

      await service.respondInvitation(LISTENER, 'r', 'inv-1', true);

      expect(seats.setOccupant).toHaveBeenCalledWith('r', 1, LISTENER.id, LISTENER.id);
      expect(seats.resolveInvitation).toHaveBeenCalledWith(
        'inv-1',
        SeatInvitationStatus.ACCEPTED,
        LISTENER.id,
      );
      expect(seats.resolveRequest).toHaveBeenCalledWith(
        'req-pending-1',
        SeatRequestStatus.CANCELLED,
        LISTENER.id,
      );
      expect(seats.appendSeatHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: 'r',
          actorId: LISTENER.id,
          action: SeatHistoryAction.REQUEST_CANCELLED,
        }),
      );
      expect(seats.dequeue).toHaveBeenCalledWith('r', LISTENER.id);

      // Real-time synchronization: request_cancelled event emitted for host and all room admins
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.seat_updated',
          payload: expect.objectContaining({
            roomId: 'r',
            reason: 'request_cancelled',
            subjectUserId: LISTENER.id,
          }),
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.seat_updated',
          payload: expect.objectContaining({
            roomId: 'r',
            reason: 'invite_accepted',
            subjectUserId: LISTENER.id,
          }),
        }),
      );
    });

    it('rejects an invitation without cancelling pending seat requests', async () => {
      seats.getInvitation.mockResolvedValue(validInvite);
      seats.findPendingRequestsByUser.mockResolvedValue([
        { id: 'req-pending-1', roomId: 'r', userId: LISTENER.id, status: SeatRequestStatus.PENDING },
      ]);

      await service.respondInvitation(LISTENER, 'r', 'inv-1', false);

      expect(seats.resolveInvitation).toHaveBeenCalledWith(
        'inv-1',
        SeatInvitationStatus.REJECTED,
        LISTENER.id,
      );
      expect(seats.setOccupant).not.toHaveBeenCalled();
      expect(seats.resolveRequest).not.toHaveBeenCalled();
      expect(seats.dequeue).not.toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.seat_updated',
          payload: expect.objectContaining({
            reason: 'invite_rejected',
            subjectUserId: LISTENER.id,
          }),
        }),
      );
      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.seat_updated',
          payload: expect.objectContaining({
            reason: 'request_cancelled',
          }),
        }),
      );
    });

    it('handles expired invitation without cancelling pending seat requests', async () => {
      const expiredInvite = {
        ...validInvite,
        expiresAt: new Date(Date.now() - 10000),
      };
      seats.getInvitation.mockResolvedValue(expiredInvite);
      seats.findPendingRequestsByUser.mockResolvedValue([
        { id: 'req-pending-1', roomId: 'r', userId: LISTENER.id, status: SeatRequestStatus.PENDING },
      ]);

      await expect(service.respondInvitation(LISTENER, 'r', 'inv-1', true)).rejects.toThrow(
        BusinessException,
      );

      expect(seats.resolveInvitation).toHaveBeenCalledWith(
        'inv-1',
        SeatInvitationStatus.EXPIRED,
        LISTENER.id,
      );
      expect(seats.resolveRequest).not.toHaveBeenCalled();
      expect(seats.dequeue).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.seat_updated',
          payload: expect.objectContaining({
            reason: 'request_cancelled',
          }),
        }),
      );
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

    it('allows a non-owner to take the owner seat when open', async () => {
      seats.getSeatByIndex.mockResolvedValue(seat({ seatType: SeatType.OWNER, seatIndex: 0 }));
      await service.takeSeat(LISTENER, 'r', 0);
      expect(seats.setOccupant).toHaveBeenCalledWith('r', 0, LISTENER.id, LISTENER.id);
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

    it('clears pending seat request when taking an open seat', async () => {
      seats.findPendingRequestsByUser.mockResolvedValue([
        { id: 'req-pending-1', roomId: 'r', userId: LISTENER.id, status: SeatRequestStatus.PENDING },
      ]);

      await service.takeSeat(LISTENER, 'r', 1);

      expect(seats.resolveRequest).toHaveBeenCalledWith(
        'req-pending-1',
        SeatRequestStatus.CANCELLED,
        LISTENER.id,
      );
      expect(seats.dequeue).toHaveBeenCalledWith('r', LISTENER.id);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.seat_updated',
          payload: expect.objectContaining({
            reason: 'request_cancelled',
            subjectUserId: LISTENER.id,
          }),
        }),
      );
    });

    /**
     * The owner is auto-seated on seat 0 when they join, so every seat move they
     * make starts from a seat they already hold. Treating that as a conflict is
     * what stranded owners off their own seat with no way back.
     */
    describe('owner seat freedom', () => {
      const ownerSeat = () => seat({ seatIndex: 0, seatType: SeatType.OWNER });

      beforeEach(() => {
        permissions.hasPermission.mockResolvedValue(true);
      });

      it('lets a seated owner return to the owner seat', async () => {
        seats.getSeatByOccupant.mockResolvedValue(seat({ seatIndex: 3 }));
        seats.getSeatByIndex.mockResolvedValue(ownerSeat());

        await service.takeSeat(OWNER, 'r', 0);

        expect(seats.setOccupant).toHaveBeenCalledWith('r', 3, null, OWNER.id);
        expect(seats.setOccupant).toHaveBeenCalledWith('r', 0, OWNER.id, OWNER.id);
      });

      it('lets a seated owner move out to a speaker seat', async () => {
        seats.getSeatByOccupant.mockResolvedValue(ownerSeat());
        seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 4 }));

        await service.takeSeat(OWNER, 'r', 4);

        expect(seats.setOccupant).toHaveBeenCalledWith('r', 0, null, OWNER.id);
        expect(seats.setOccupant).toHaveBeenCalledWith('r', 4, OWNER.id, OWNER.id);
      });

      it('moves the owner back and forth repeatedly', async () => {
        for (const [from, to] of [
          [0, 2],
          [2, 0],
          [0, 5],
          [5, 0],
        ]) {
          seats.setOccupant.mockClear();
          seats.getSeatByOccupant.mockResolvedValue(
            from === 0 ? ownerSeat() : seat({ seatIndex: from }),
          );
          seats.getSeatByIndex.mockResolvedValue(to === 0 ? ownerSeat() : seat({ seatIndex: to }));

          await service.takeSeat(OWNER, 'r', to);

          expect(seats.setOccupant).toHaveBeenCalledWith('r', from, null, OWNER.id);
          expect(seats.setOccupant).toHaveBeenCalledWith('r', to, OWNER.id, OWNER.id);
        }
      });

      it('announces a move as one `moved` update, not a leave/join pair', async () => {
        seats.getSeatByOccupant.mockResolvedValue(seat({ seatIndex: 3 }));
        seats.getSeatByIndex.mockResolvedValue(ownerSeat());

        await service.takeSeat(OWNER, 'r', 0);

        const names = bus.publish.mock.calls.map(([e]) => (e as { name: string }).name);
        expect(names).toContain('audio_room.seat_updated');
        expect(names).not.toContain('audio_room.seat_left');
        expect(names).not.toContain('audio_room.seat_joined');
      });

      it('tapping the seat you already hold is a no-op, not a conflict', async () => {
        seats.getSeatByOccupant.mockResolvedValue(ownerSeat());
        seats.getSeatByIndex.mockResolvedValue(ownerSeat());

        await expect(service.takeSeat(OWNER, 'r', 0)).resolves.toBeDefined();
        expect(seats.setOccupant).not.toHaveBeenCalled();
      });

      it('leaves the owner where they are when the destination is occupied', async () => {
        seats.getSeatByOccupant.mockResolvedValue(ownerSeat());
        seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 2, occupantUserId: 'someone' }));

        await expect(service.takeSeat(OWNER, 'r', 2)).rejects.toBeInstanceOf(BusinessException);
        // Critically: the owner seat was NOT vacated on the way to failing.
        expect(seats.setOccupant).not.toHaveBeenCalled();
      });

      // The relaxation reaches the owner and MANAGE_SEATS holders — it must not
      it('lets a seated speaker move freely to an open speaker seat', async () => {
        permissions.hasPermission.mockResolvedValue(false);
        seats.getSeatByOccupant.mockResolvedValue(seat({ seatIndex: 3, occupantUserId: LISTENER.id }));
        seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 4, occupantUserId: null }));

        await service.takeSeat(LISTENER, 'r', 4);
        expect(seats.setOccupant).toHaveBeenCalledWith('r', 3, null, LISTENER.id);
        expect(seats.setOccupant).toHaveBeenCalledWith('r', 4, LISTENER.id, LISTENER.id);
      });

      it('allows a seated speaker to move even when room requires approval for taking seats', async () => {
        seats.getSettings.mockResolvedValue({ requireApprovalForSeat: true });
        permissions.hasPermission.mockResolvedValue(false);
        seats.getSeatByOccupant.mockResolvedValue(seat({ seatIndex: 2, occupantUserId: LISTENER.id }));
        seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 5, occupantUserId: null }));

        await service.takeSeat(LISTENER, 'r', 5);
        expect(seats.setOccupant).toHaveBeenCalledWith('r', 2, null, LISTENER.id);
        expect(seats.setOccupant).toHaveBeenCalledWith('r', 5, LISTENER.id, LISTENER.id);
      });

      it('allows a seated speaker to move to the open owner seat (seat 0)', async () => {
        permissions.hasPermission.mockResolvedValue(false);
        seats.getSeatByOccupant.mockResolvedValue(seat({ seatIndex: 3, occupantUserId: LISTENER.id }));
        seats.getSeatByIndex.mockResolvedValue(ownerSeat());

        await service.takeSeat(LISTENER, 'r', 0);
        expect(seats.setOccupant).toHaveBeenCalledWith('r', 3, null, LISTENER.id);
        expect(seats.setOccupant).toHaveBeenCalledWith('r', 0, LISTENER.id, LISTENER.id);
      });
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

  /**
   * A seat mute is a moderation action against a *person*, but it is stored on
   * the seat row. Everything below pins the flag to the occupant so it can never
   * be inherited by whoever sits down next.
   */
  describe('setRoomMuted', () => {
    it('mutes all speaker seats and flags the room', async () => {
      await service.setRoomMuted(OWNER, 'r', true);
      expect(seats.setRoomMutedTx).toHaveBeenCalledWith('r', true, OWNER.id);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.seat_updated' }),
      );
    });

    /**
     * Broad Mute writes `isMuted` onto every speaker seat. Lifting it has to
     * write them back, or the flag outlives the mute that set it — and since
     * the seat, not the occupant, carries it, the next person to sit there is
     * silenced by a mute that is no longer in force. That is what stranded the
     * owner: seat 0 is a SeatType.OWNER seat, which Broad Mute never touches,
     * so they were audible there and mute everywhere else.
     */
    it('unmutes the speaker seats it muted when broad mute is lifted', async () => {
      await service.setRoomMuted(OWNER, 'r', false);
      expect(seats.setRoomMutedTx).toHaveBeenCalledWith('r', false, OWNER.id);
    });

    /**
     * Broad Mute is two writes — the room flag and the per-seat fan-out — and
     * the two have to agree or the room is stranded: seats muted under a flag
     * that reads false leaves every speaker silent with `canToggleMic` false
     * and no way back except another full toggle. Splitting them across two
     * calls let a second toggle interleave between them, so they are issued as
     * one repository call and, like every other seat mutation in this service,
     * under the room seat lock.
     */
    it('writes the room flag and the seat fan-out as one atomic call', async () => {
      await service.setRoomMuted(OWNER, 'r', true);
      expect(seats.setRoomMutedTx).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent toggles by writing inside the room seat lock', async () => {
      const order: string[] = [];
      locks.withLock = jest.fn(async <T>(_k: string, fn: () => Promise<T>) => {
        order.push('lock:enter');
        const result = await fn();
        order.push('lock:exit');
        return result;
      }) as never;
      seats.setRoomMutedTx.mockImplementation(async () => {
        order.push('write');
      });
      await service.setRoomMuted(OWNER, 'r', true);
      expect(order).toEqual(['lock:enter', 'write', 'lock:exit']);
    });
  });

  describe('seat mute does not outlive its occupant', () => {
    it('clears the seat mute when the occupant leaves', async () => {
      seats.getSeatByOccupant.mockResolvedValue(
        seat({ occupantUserId: LISTENER.id, isMuted: true }),
      );
      await service.leaveSeat(LISTENER, 'r');
      expect(seats.setSeatMuted).toHaveBeenCalledWith('r', 1, false, LISTENER.id);
    });

    it('clears the seat mute when a moderator removes the speaker', async () => {
      seats.getSeatByOccupant.mockResolvedValue(
        seat({ occupantUserId: LISTENER.id, isMuted: true }),
      );
      await service.removeSpeaker(OWNER, 'r', LISTENER.id);
      expect(seats.setSeatMuted).toHaveBeenCalledWith('r', 1, false, OWNER.id);
    });

    it('does not touch the mute flag on a seat that was not muted', async () => {
      seats.getSeatByOccupant.mockResolvedValue(
        seat({ occupantUserId: LISTENER.id, isMuted: false }),
      );
      await service.leaveSeat(LISTENER, 'r');
      expect(seats.setSeatMuted).not.toHaveBeenCalled();
    });

    /**
     * The owner is exempt from Broad Mute everywhere else — VoiceService.setSelfMute
     * lets them unmute through it, and the client zeroes `roomMuted` for them. The
     * exemption has to key off *who* they are, not which seat they landed on, or
     * moving one seat over silences the host of a broad-muted room.
     */
    it('does not seat-mute the owner taking a speaker seat in a broad-muted room', async () => {
      permissions.hasPermission.mockResolvedValue(true);
      seats.isRoomMuted.mockResolvedValue(true);
      seats.getSeatByOccupant.mockResolvedValue(
        seat({ seatIndex: 0, seatType: SeatType.OWNER, occupantUserId: OWNER.id }),
      );
      seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 4 }));

      await service.takeSeat(OWNER, 'r', 4);

      expect(seats.setSeatMuted).not.toHaveBeenCalledWith('r', 4, true, OWNER.id);
    });

    it('refuses to seat-mute the owner, whichever seat they are on', async () => {
      seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 4, occupantUserId: OWNER.id }));
      await expect(service.setSeatMuted(LISTENER, 'r', 4, true)).rejects.toBeInstanceOf(
        BusinessException,
      );
      expect(seats.setSeatMuted).not.toHaveBeenCalled();
    });

    it('still allows unmuting the owner seat', async () => {
      seats.getSeatByIndex.mockResolvedValue(
        seat({ seatIndex: 4, occupantUserId: OWNER.id, isMuted: true }),
      );
      await service.setSeatMuted(LISTENER, 'r', 4, false);
      expect(seats.setSeatMuted).toHaveBeenCalledWith('r', 4, false, LISTENER.id);
    });

    /**
     * The heal path for rooms that toggled Broad Mute on an older build: those
     * chairs are still armed with no occupant, and no amount of leaving fixes
     * them because nobody is sitting there. Taking the seat clears it.
     */
    it('clears a stale mute left on an empty seat when someone takes it', async () => {
      permissions.hasPermission.mockResolvedValue(true);
      seats.isRoomMuted.mockResolvedValue(false);
      seats.getSeatByOccupant.mockResolvedValue(null);
      seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 4, isMuted: true }));

      await service.takeSeat(LISTENER, 'r', 4);

      expect(seats.setSeatMuted).toHaveBeenCalledWith('r', 4, false, LISTENER.id);
    });

    it('still seat-mutes a non-owner taking a speaker seat in a broad-muted room', async () => {
      permissions.hasPermission.mockResolvedValue(true);
      seats.isRoomMuted.mockResolvedValue(true);
      seats.getSeatByOccupant.mockResolvedValue(null);
      seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 4 }));

      await service.takeSeat(LISTENER, 'r', 4);

      expect(seats.setSeatMuted).toHaveBeenCalledWith('r', 4, true, LISTENER.id);
    });
  });

  /**
   * A room row is permanent and reused for every live, so "the room ended" is the
   * only boundary at which session-scoped participant state can be dropped. If it
   * is not dropped here, the next live inherits the previous one's admins.
   */
  describe('onRoomClosed', () => {
    it('wipes session state, not just the stage', async () => {
      await service.onRoomClosed('r');

      expect(seats.clearSessionStateTx).toHaveBeenCalledWith('r');
    });

    it('invalidates the cached stage so no client reads the old roster', async () => {
      await service.onRoomClosed('r');

      expect(seats.invalidateStage).toHaveBeenCalledWith('r');
    });
  });

  /**
   * Reopening is the second line of defence: rooms that ended before this fix (or
   * via a path that skipped the ENDED event) still carry stale grants, and the
   * owner reopening the room must not walk into last session's admin list.
   *
   * The `restarted` flag matters — the client calls start-then-join on *every*
   * owner entry, so a redundant start on an already-LIVE room must never wipe the
   * admins of the session currently in progress.
   */
  describe('onRoomOpened', () => {
    it('clears leftover session state when a new live is starting', async () => {
      await service.onRoomOpened('r', OWNER.id, true);

      expect(seats.clearSessionStateTx).toHaveBeenCalledWith('r');
    });

    it('leaves roles alone on a redundant start of an already-live room', async () => {
      await service.onRoomOpened('r', OWNER.id, false);

      expect(seats.clearSessionStateTx).not.toHaveBeenCalled();
    });

    it('still seats the owner on seat 0 either way', async () => {
      await service.onRoomOpened('r', OWNER.id, false);

      expect(seats.setOccupant).toHaveBeenCalledWith('r', 0, OWNER.id, OWNER.id);
    });

    /**
     * The client calls start-then-join on every owner entry, and `create()`
     * reopening an ended room already calls this once internally — so a real
     * reactivation is followed by a redundant `restarted: false` call in the
     * same entry. Without this guard, that redundant call re-wrote the
     * already-correct seat-0 occupant and re-published SeatJoinedEvent, which
     * showed up as a second "joined as speaker" system message and a seat
     * flicker on the client.
     */
    it('does not re-seat or re-publish when the owner already holds seat 0', async () => {
      seats.getSeatByOccupant.mockResolvedValue(seat({ seatIndex: 0, occupantUserId: OWNER.id }));

      await service.onRoomOpened('r', OWNER.id, false);

      expect(seats.setOccupant).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  describe('onMemberLeave', () => {
    it('clears pending seat request and broadcasts cancellation in real-time when user leaves', async () => {
      seats.findPendingRequestsByUser.mockResolvedValue([
        { id: 'req-leave-1', roomId: 'r', userId: LISTENER.id, status: SeatRequestStatus.PENDING },
      ]);

      await service.onMemberLeave('r', LISTENER.id);

      expect(seats.resolveRequest).toHaveBeenCalledWith(
        'req-leave-1',
        SeatRequestStatus.CANCELLED,
        LISTENER.id,
      );
      expect(seats.dequeue).toHaveBeenCalledWith('r', LISTENER.id);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.seat_updated',
          payload: expect.objectContaining({
            roomId: 'r',
            reason: 'request_cancelled',
            subjectUserId: LISTENER.id,
          }),
        }),
      );
    });

    it('does not publish request_cancelled when leaving user had no pending requests', async () => {
      seats.findPendingRequestsByUser.mockResolvedValue([]);

      await service.onMemberLeave('r', LISTENER.id);

      expect(seats.resolveRequest).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.seat_updated',
          payload: expect.objectContaining({
            reason: 'request_cancelled',
          }),
        }),
      );
    });
  });

  /**
   * Seat-move freedom was written for the owner alone, so an admin who was
   * already seated could not move — including into a seat they had just
   * unlocked. Anyone trusted with MANAGE_SEATS gets the same freedom; the owner
   * seat stays protected by the seat-type check that runs after.
   */
  describe('admin seat freedom', () => {
    beforeEach(() => {
      seats.getSettings.mockResolvedValue({
        requireApprovalForSeat: false,
        speakerSeatCount: 8,
        premiumAdminSeatCount: 0,
      });
      // MANAGE_SEATS holder.
      permissions.hasPermission.mockResolvedValue(true);
    });

    it('lets a seated admin move straight to another speaker seat', async () => {
      seats.getSeatByOccupant.mockResolvedValue(seat({ seatIndex: 3 }));
      seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 5 }));

      await service.takeSeat(ADMIN, 'r', 5);

      expect(seats.setOccupant).toHaveBeenCalledWith('r', 3, null, ADMIN.id);
      expect(seats.setOccupant).toHaveBeenCalledWith('r', 5, ADMIN.id, ADMIN.id);
    });

    it('allows an admin or speaker to sit on the top seat when open', async () => {
      seats.getSeatByOccupant.mockResolvedValue(seat({ seatIndex: 3 }));
      seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 0, seatType: SeatType.OWNER }));

      await service.takeSeat(ADMIN, 'r', 0);
      expect(seats.setOccupant).toHaveBeenCalledWith('r', 3, null, ADMIN.id);
      expect(seats.setOccupant).toHaveBeenCalledWith('r', 0, ADMIN.id, ADMIN.id);
    });

    it('allows an ordinary seated member to move to an open speaker seat', async () => {
      permissions.hasPermission.mockResolvedValue(false);
      seats.getSeatByOccupant.mockResolvedValue(seat({ seatIndex: 3 }));
      seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 5 }));

      await service.takeSeat(LISTENER, 'r', 5);
      expect(seats.setOccupant).toHaveBeenCalledWith('r', 3, null, LISTENER.id);
      expect(seats.setOccupant).toHaveBeenCalledWith('r', 5, LISTENER.id, LISTENER.id);
    });
  });

  /**
   * Muting the owner was already blocked, but unmuting was documented as
   * "always allowed". That let one admin lift a seat mute another admin — or the
   * owner — had applied.
   */
  describe('seat unmute respects authority', () => {
    it('rank-checks the occupant before lifting a seat mute', async () => {
      seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 2, occupantUserId: 'admin-b' }));
      permissions.assertOutranks.mockRejectedValue(new Error('INSUFFICIENT_AUTHORITY'));

      await expect(service.setSeatMuted(ADMIN, 'r', 2, false)).rejects.toThrow(
        'INSUFFICIENT_AUTHORITY',
      );
      expect(seats.setSeatMuted).not.toHaveBeenCalled();
    });

    it('still lets an empty seat be unmuted, which targets nobody', async () => {
      seats.getSeatByIndex.mockResolvedValue(seat({ seatIndex: 2, occupantUserId: null }));

      await service.setSeatMuted(ADMIN, 'r', 2, false);

      expect(permissions.assertOutranks).not.toHaveBeenCalled();
      expect(seats.setSeatMuted).toHaveBeenCalledWith('r', 2, false, ADMIN.id);
    });
  });
});
