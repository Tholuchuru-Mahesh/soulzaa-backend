import { VideoRoomSeatStatus, VideoRoomSeatType, VideoRoomStatus } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { SeatEntrySnapshot, SeatStageSnapshot } from '../interfaces/seat-stage.interface';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomSeatService } from './video-room-seat.service';

const actor = (id: string): RoomActor => ({ id, roles: [] });

const emptySeat = (
  i: number,
  type: VideoRoomSeatType = VideoRoomSeatType.HOST,
): SeatEntrySnapshot => ({
  seatIndex: i,
  seatType: type,
  status: VideoRoomSeatStatus.EMPTY,
  occupantUserId: null,
  reservedForUserId: null,
  isLocked: false,
  isMuted: false,
  isVideoOn: false,
  reason: null,
  premium: false,
});

const snapshot = (seats: SeatEntrySnapshot[]): SeatStageSnapshot => ({
  roomId: 'r',
  version: 1,
  updatedAt: 't',
  hostSeatCount: 9,
  guestSeatCount: 0,
  seats,
});

describe('VideoRoomSeatService (core)', () => {
  let deps: any;
  let svc: VideoRoomSeatService;

  beforeEach(() => {
    deps = {
      locks: { withLock: jest.fn((_k: string, fn: () => unknown) => fn()) },
      seatState: {
        getSnapshot: jest.fn(),
        rebuild: jest.fn(),
        commit: jest.fn(
          (_r: string, base: SeatStageSnapshot, patch: Partial<SeatStageSnapshot>) => ({
            ...base,
            ...patch,
            version: base.version + 1,
          }),
        ),
      },
      seats: {
        updateSeat: jest.fn(),
        listPendingRequests: jest.fn().mockResolvedValue([]),
        listPendingInvitationsForRoom: jest.fn().mockResolvedValue([]),
        createLayout: jest.fn().mockResolvedValue(0),
        deleteSeatsFrom: jest.fn().mockResolvedValue(0),
        setSeatLayout: jest.fn(),
      },
      rooms: {
        findById: jest
          .fn()
          .mockResolvedValue({ id: 'r', ownerId: 'owner', status: VideoRoomStatus.LIVE }),
        getMember: jest.fn().mockResolvedValue({ isActive: true }),
      },
      permissions: { assertPermission: jest.fn(), assertOutranks: jest.fn() },
      events: { appendEvent: jest.fn() },
      bus: { publish: jest.fn() },
    };
    svc = new VideoRoomSeatService(
      deps.locks,
      deps.seatState,
      deps.seats,
      deps.rooms,
      deps.permissions,
      deps.events,
      deps.bus,
    );
  });

  it('takeSeat seats an active member on an EMPTY seat + write-throughs + publishes', async () => {
    deps.seatState.getSnapshot.mockResolvedValue(snapshot([emptySeat(1)]));
    await svc.takeSeat(actor('u'), 'r', 1);
    expect(deps.seats.updateSeat).toHaveBeenCalledWith(
      'r',
      1,
      expect.objectContaining({
        seatStatus: VideoRoomSeatStatus.OCCUPIED,
        occupantUserId: 'u',
        reservedForUserId: null,
      }),
      'u',
    );
    expect(deps.events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'seat.taken' }),
    );
    expect(deps.bus.publish).toHaveBeenCalled();
  });

  it('takeSeat rejects an already-occupied seat with SEAT_TAKEN', async () => {
    deps.seatState.getSnapshot.mockResolvedValue(
      snapshot([{ ...emptySeat(1), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'x' }]),
    );
    await expect(svc.takeSeat(actor('u'), 'r', 1)).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_TAKEN,
    });
  });

  it('takeSeat rejects a locked seat with SEAT_LOCKED', async () => {
    deps.seatState.getSnapshot.mockResolvedValue(
      snapshot([{ ...emptySeat(1), status: VideoRoomSeatStatus.LOCKED, isLocked: true }]),
    );
    await expect(svc.takeSeat(actor('u'), 'r', 1)).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_LOCKED,
    });
  });

  it('takeSeat rejects a seat reserved for someone else with SEAT_RESERVED', async () => {
    deps.seatState.getSnapshot.mockResolvedValue(
      snapshot([
        { ...emptySeat(1), status: VideoRoomSeatStatus.RESERVED, reservedForUserId: 'other' },
      ]),
    );
    await expect(svc.takeSeat(actor('u'), 'r', 1)).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_RESERVED,
    });
  });

  it('takeSeat rejects a second seat for the same user (ALREADY_ON_SEAT)', async () => {
    deps.seatState.getSnapshot.mockResolvedValue(
      snapshot([
        { ...emptySeat(1), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'u' },
        emptySeat(2),
      ]),
    );
    await expect(svc.takeSeat(actor('u'), 'r', 2)).rejects.toMatchObject({
      errorCode: ERROR_CODES.ALREADY_ON_SEAT,
    });
  });

  it('takeSeat forbids the owner seat for a non-owner (SEAT_TYPE_FORBIDDEN)', async () => {
    deps.seatState.getSnapshot.mockResolvedValue(snapshot([emptySeat(0, VideoRoomSeatType.OWNER)]));
    await expect(svc.takeSeat(actor('u'), 'r', 0)).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_TYPE_FORBIDDEN,
    });
  });

  it('leaveSeat vacates the occupant and publishes', async () => {
    deps.seatState.getSnapshot.mockResolvedValue(
      snapshot([{ ...emptySeat(1), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'u' }]),
    );
    await svc.leaveSeat(actor('u'), 'r');
    expect(deps.seats.updateSeat).toHaveBeenCalledWith(
      'r',
      1,
      expect.objectContaining({ seatStatus: VideoRoomSeatStatus.EMPTY, occupantUserId: null }),
      'u',
    );
    expect(deps.bus.publish).toHaveBeenCalled();
  });

  it('leaveSeat rejects when the caller is not seated (NOT_ON_SEAT)', async () => {
    deps.seatState.getSnapshot.mockResolvedValue(snapshot([emptySeat(1)]));
    await expect(svc.leaveSeat(actor('u'), 'r')).rejects.toMatchObject({
      errorCode: ERROR_CODES.NOT_ON_SEAT,
    });
  });

  it('getStage returns a versioned view without taking the lock', async () => {
    deps.seatState.getSnapshot.mockResolvedValue(snapshot([emptySeat(1)]));
    const view = await svc.getStage(actor('u'), 'r');
    expect(view.version).toBe(1);
    expect(view.seats).toHaveLength(1);
    expect(deps.locks.withLock).not.toHaveBeenCalled();
  });

  describe('lock / unlock', () => {
    it('lockSeats requires MANAGE_SEATS and locks + vacates the occupant with a reason', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot([{ ...emptySeat(1), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'x' }]),
      );
      await svc.lockSeats(actor('owner'), 'r', [1], 'maintenance');
      expect(deps.permissions.assertPermission).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'owner' }),
        expect.objectContaining({ id: 'r' }),
        'MANAGE_SEATS',
      );
      expect(deps.seats.updateSeat).toHaveBeenCalledWith(
        'r',
        1,
        expect.objectContaining({
          seatStatus: VideoRoomSeatStatus.LOCKED,
          isLocked: true,
          occupantUserId: null,
          metadata: expect.objectContaining({ reason: 'maintenance' }),
        }),
        'owner',
      );
    });

    it('lockSeats rejects the owner seat (SEAT_TYPE_FORBIDDEN)', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot([emptySeat(0, VideoRoomSeatType.OWNER)]),
      );
      await expect(svc.lockSeats(actor('owner'), 'r', [0])).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_TYPE_FORBIDDEN,
      });
    });

    it('unlockSeats clears the lock back to EMPTY', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot([
          {
            ...emptySeat(1),
            status: VideoRoomSeatStatus.LOCKED,
            isLocked: true,
            reason: 'maintenance',
          },
        ]),
      );
      await svc.unlockSeats(actor('owner'), 'r', [1]);
      expect(deps.seats.updateSeat).toHaveBeenCalledWith(
        'r',
        1,
        expect.objectContaining({ seatStatus: VideoRoomSeatStatus.EMPTY, isLocked: false }),
        'owner',
      );
    });
  });

  describe('configureLayout', () => {
    it('rejects a layout exceeding the max seats (SEAT_LAYOUT_INVALID)', async () => {
      await expect(svc.configureLayout(actor('owner'), 'r', 30, 30)).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_LAYOUT_INVALID,
      });
    });

    it('shrinking vacates a displaced occupant and persists the new counts', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot([
          emptySeat(0, VideoRoomSeatType.OWNER),
          emptySeat(1),
          { ...emptySeat(5), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'displaced' },
        ]),
      );
      await svc.configureLayout(actor('owner'), 'r', 1, 0); // total = 2 → seat 5 removed
      expect(deps.seats.setSeatLayout).toHaveBeenCalledWith('r', 1, 0, 'owner');
      expect(deps.seats.deleteSeatsFrom).toHaveBeenCalledWith('r', 2);
      // displaced occupant on seat 5 gets a SeatLeftEvent
      const published = deps.bus.publish.mock.calls.map((c: any[]) => c[0].constructor.name);
      expect(published).toContain('SeatLeftEvent');
    });
  });

  describe('switch / transfer / remove', () => {
    it('switchSeat moves the caller to an empty destination', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot([
          { ...emptySeat(1), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'u' },
          emptySeat(2),
        ]),
      );
      await svc.switchSeat(actor('u'), 'r', 2);
      expect(deps.seats.updateSeat).toHaveBeenCalledWith(
        'r',
        1,
        expect.objectContaining({ seatStatus: VideoRoomSeatStatus.EMPTY, occupantUserId: null }),
        'u',
      );
      expect(deps.seats.updateSeat).toHaveBeenCalledWith(
        'r',
        2,
        expect.objectContaining({ seatStatus: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'u' }),
        'u',
      );
      const published = deps.bus.publish.mock.calls.map((c: any[]) => c[0].constructor.name);
      expect(published).toContain('SeatSwitchedEvent');
    });

    it('switchSeat rejects when the caller is not seated (NOT_ON_SEAT)', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(snapshot([emptySeat(1), emptySeat(2)]));
      await expect(svc.switchSeat(actor('u'), 'r', 2)).rejects.toMatchObject({
        errorCode: ERROR_CODES.NOT_ON_SEAT,
      });
    });

    it('transferSeat requires MANAGE_PARTICIPANTS + outrank and moves the target', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot([
          { ...emptySeat(1), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'target' },
          emptySeat(2),
        ]),
      );
      await svc.transferSeat(actor('owner'), 'r', 'target', 2);
      expect(deps.permissions.assertPermission).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'MANAGE_PARTICIPANTS',
      );
      expect(deps.permissions.assertOutranks).toHaveBeenCalledWith(
        expect.anything(),
        'owner',
        'target',
      );
      const published = deps.bus.publish.mock.calls.map((c: any[]) => c[0].constructor.name);
      expect(published).toContain('SeatTransferredEvent');
    });

    it('transferSeat rejects a taken destination without force (SEAT_TAKEN)', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot([
          { ...emptySeat(1), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'target' },
          { ...emptySeat(2), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'sitting' },
        ]),
      );
      await expect(svc.transferSeat(actor('owner'), 'r', 'target', 2)).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_TAKEN,
      });
    });

    it('transferSeat with force evicts the destination occupant (SeatLeftEvent)', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot([
          { ...emptySeat(1), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'target' },
          { ...emptySeat(2), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'sitting' },
        ]),
      );
      await svc.transferSeat(actor('owner'), 'r', 'target', 2, undefined, true);
      const published = deps.bus.publish.mock.calls.map((c: any[]) => c[0].constructor.name);
      expect(published).toContain('SeatLeftEvent');
      expect(published).toContain('SeatTransferredEvent');
    });

    it('removeFromSeat vacates the target with permission + outrank checks', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot([
          { ...emptySeat(1), status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'target' },
        ]),
      );
      await svc.removeFromSeat(actor('owner'), 'r', 'target');
      expect(deps.permissions.assertOutranks).toHaveBeenCalled();
      expect(deps.seats.updateSeat).toHaveBeenCalledWith(
        'r',
        1,
        expect.objectContaining({ seatStatus: VideoRoomSeatStatus.EMPTY, occupantUserId: null }),
        'owner',
      );
    });
  });
});
