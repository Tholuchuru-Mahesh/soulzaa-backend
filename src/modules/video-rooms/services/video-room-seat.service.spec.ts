import { VideoRoomSeatStatus, VideoRoomSeatType, VideoRoomStatus } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { buildSeatLayout } from '../constants/video-room-seat-lifecycle';
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

  describe('findOpenSeat', () => {
    /** The stage a brand-new room now rebuilds to: 1 owner + 9 host seats, all EMPTY. */
    const freshRoomStage = (): SeatStageSnapshot =>
      snapshot(buildSeatLayout(9, 0).map((s) => emptySeat(s.seatIndex, s.seatType)));

    it('returns the first non-owner EMPTY seat on a freshly created room', async () => {
      // Cold cache → rebuild, exactly as `getStage` does for a room nobody has touched.
      deps.seatState.getSnapshot.mockResolvedValue(null);
      deps.seatState.rebuild.mockResolvedValue(freshRoomStage());

      await expect(svc.findOpenSeat(actor('u'), 'r')).resolves.toBe(1);
    });

    it('skips the owner seat even when it is the only empty one', async () => {
      const seats = buildSeatLayout(9, 0).map((s) =>
        s.seatIndex === 0
          ? emptySeat(0, VideoRoomSeatType.OWNER)
          : {
              ...emptySeat(s.seatIndex, s.seatType),
              status: VideoRoomSeatStatus.OCCUPIED,
              occupantUserId: `u${s.seatIndex}`,
            },
      );
      deps.seatState.getSnapshot.mockResolvedValue(snapshot(seats));

      await expect(svc.findOpenSeat(actor('u'), 'r')).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_FULL,
      });
    });

    it('still throws SEAT_FULL when every non-owner seat is genuinely occupied', async () => {
      const seats = buildSeatLayout(2, 1).map((s) =>
        s.seatIndex === 0
          ? emptySeat(0, VideoRoomSeatType.OWNER)
          : {
              ...emptySeat(s.seatIndex, s.seatType),
              status: VideoRoomSeatStatus.OCCUPIED,
              occupantUserId: `u${s.seatIndex}`,
            },
      );
      deps.seatState.getSnapshot.mockResolvedValue(snapshot(seats));

      await expect(svc.findOpenSeat(actor('u'), 'r')).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_FULL,
      });
    });

    it('skips locked seats and returns the next claimable one', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot([
          emptySeat(0, VideoRoomSeatType.OWNER),
          { ...emptySeat(1), status: VideoRoomSeatStatus.LOCKED, isLocked: true },
          emptySeat(2),
        ]),
      );

      await expect(svc.findOpenSeat(actor('u'), 'r')).resolves.toBe(2);
    });
  });

  describe('configureLayout', () => {
    it('rejects a layout exceeding the max seats (SEAT_LAYOUT_INVALID)', async () => {
      await expect(svc.configureLayout(actor('owner'), 'r', 30, 30)).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_LAYOUT_INVALID,
      });
    });

    it('persists seatType to the DB for pre-materialised indices whose type changed', async () => {
      // A room as `createRoomTx` / the rebuild backfill now leaves it: every index
      // already exists, so `createLayout`'s skipDuplicates insert is a no-op for them.
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot(buildSeatLayout(9, 0).map((s) => emptySeat(s.seatIndex, s.seatType))),
      );

      await svc.configureLayout(actor('owner'), 'r', 2, 3); // total 6 → 3,4,5 become GUEST

      // Assert on what the REPOSITORY was told to persist — the Redis snapshot was
      // already correct and is exactly what hid this bug.
      const typeWrites = deps.seats.updateSeat.mock.calls.map((c: any[]) => [c[0], c[1], c[2]]);
      expect(typeWrites).toEqual([
        ['r', 3, { seatType: VideoRoomSeatType.GUEST }],
        ['r', 4, { seatType: VideoRoomSeatType.GUEST }],
        ['r', 5, { seatType: VideoRoomSeatType.GUEST }],
      ]);
      // …stamped with the acting user, and nothing written for the unchanged indices
      // 0 (OWNER), 1 and 2 (still HOST), nor for 6..9 which are deleted instead.
      expect(deps.seats.updateSeat.mock.calls.every((c: any[]) => c[3] === 'owner')).toBe(true);
      expect(deps.seats.deleteSeatsFrom).toHaveBeenCalledWith('r', 6);
    });

    it('writes nothing when the layout is reapplied unchanged', async () => {
      deps.seatState.getSnapshot.mockResolvedValue(
        snapshot(buildSeatLayout(9, 0).map((s) => emptySeat(s.seatIndex, s.seatType))),
      );

      await svc.configureLayout(actor('owner'), 'r', 9, 0);

      expect(deps.seats.updateSeat).not.toHaveBeenCalled();
    });

    it('re-typing a seat leaves its occupant untouched', async () => {
      const seats = buildSeatLayout(9, 0).map((s) =>
        s.seatIndex === 4
          ? {
              ...emptySeat(4, s.seatType),
              status: VideoRoomSeatStatus.OCCUPIED,
              occupantUserId: 'sitter',
            }
          : emptySeat(s.seatIndex, s.seatType),
      );
      deps.seatState.getSnapshot.mockResolvedValue(snapshot(seats));

      await svc.configureLayout(actor('owner'), 'r', 2, 3);

      // Seat 4 is re-typed HOST→GUEST; the write carries seatType and nothing else.
      const seat4 = deps.seats.updateSeat.mock.calls.find((c: any[]) => c[1] === 4);
      expect(seat4[2]).toEqual({ seatType: VideoRoomSeatType.GUEST });
      // No vacate event for a seat that merely changed type.
      const published = deps.bus.publish.mock.calls.map((c: any[]) => c[0].constructor.name);
      expect(published).not.toContain('SeatLeftEvent');
      // …and the committed snapshot still shows the occupant on the now-GUEST seat.
      const committed = deps.seatState.commit.mock.calls[0][2].seats;
      expect(committed.find((s: any) => s.seatIndex === 4)).toMatchObject({
        seatType: VideoRoomSeatType.GUEST,
        occupantUserId: 'sitter',
        status: VideoRoomSeatStatus.OCCUPIED,
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
