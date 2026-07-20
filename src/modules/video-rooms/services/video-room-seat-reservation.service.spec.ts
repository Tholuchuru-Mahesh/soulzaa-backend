import { VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { SeatEntrySnapshot, SeatStageSnapshot } from '../interfaces/seat-stage.interface';
import { VideoRoomSeatReservationService } from './video-room-seat-reservation.service';

const seat = (i: number, over: Partial<SeatEntrySnapshot> = {}): SeatEntrySnapshot => ({
  seatIndex: i,
  seatType: VideoRoomSeatType.HOST,
  status: VideoRoomSeatStatus.EMPTY,
  occupantUserId: null,
  reservedForUserId: null,
  isLocked: false,
  isMuted: false,
  isVideoOn: false,
  reason: null,
  premium: false,
  ...over,
});

describe('VideoRoomSeatReservationService', () => {
  let base: SeatStageSnapshot;
  let deps: any;
  let svc: VideoRoomSeatReservationService;

  beforeEach(() => {
    base = {
      roomId: 'r',
      version: 1,
      updatedAt: 't',
      hostSeatCount: 9,
      guestSeatCount: 0,
      seats: [seat(1)],
    };
    deps = {
      seatSvc: {
        requireLiveRoom: jest.fn().mockResolvedValue({ id: 'r', ownerId: 'owner' }),
        mutateStage: jest.fn(async (_r: string, fn: (b: SeatStageSnapshot) => Promise<unknown>) => {
          await fn(base);
          return { roomId: 'r', version: base.version + 1, seats: [] };
        }),
      },
      seatState: {
        commit: jest.fn((_r: string, b: SeatStageSnapshot, patch: Partial<SeatStageSnapshot>) => ({
          ...b,
          ...patch,
          version: b.version + 1,
        })),
      },
      seats: { updateSeat: jest.fn() },
      cache: { set: jest.fn(), del: jest.fn() },
      permissions: { assertPermission: jest.fn() },
      events: { appendEvent: jest.fn() },
      bus: { publish: jest.fn() },
    };
    svc = new VideoRoomSeatReservationService(
      deps.seatSvc,
      deps.seatState,
      deps.seats,
      deps.cache,
      deps.permissions,
      deps.events,
      deps.bus,
    );
  });

  const pub = () => deps.bus.publish.mock.calls.map((c: any[]) => c[0].constructor.name);

  it('reserve requires MANAGE_SEATS, marks RESERVED, writes the TTL hold + publishes', async () => {
    await svc.reserve({ id: 'owner', roles: [] }, 'r', 1, 'guest', 90);
    expect(deps.permissions.assertPermission).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'MANAGE_SEATS',
    );
    expect(deps.seats.updateSeat).toHaveBeenCalledWith(
      'r',
      1,
      expect.objectContaining({
        seatStatus: VideoRoomSeatStatus.RESERVED,
        reservedForUserId: 'guest',
      }),
      'owner',
    );
    expect(deps.cache.set).toHaveBeenCalledWith(
      'video-room:{r}:seat:1:hold',
      { forUserId: 'guest' },
      90,
    );
    expect(pub()).toContain('SeatReservedEvent');
  });

  it('reserve rejects an occupied seat with SEAT_TAKEN', async () => {
    base.seats = [seat(1, { status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'x' })];
    await expect(svc.reserve({ id: 'owner', roles: [] }, 'r', 1, 'guest')).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_TAKEN,
    });
  });

  it('cancelReservation clears the hold and releases the seat', async () => {
    base.seats = [seat(1, { status: VideoRoomSeatStatus.RESERVED, reservedForUserId: 'guest' })];
    await svc.cancelReservation({ id: 'owner', roles: [] }, 'r', 1);
    expect(deps.seats.updateSeat).toHaveBeenCalledWith(
      'r',
      1,
      expect.objectContaining({ seatStatus: VideoRoomSeatStatus.EMPTY, reservedForUserId: null }),
      'owner',
    );
    expect(deps.cache.del).toHaveBeenCalledWith('video-room:{r}:seat:1:hold');
    expect(pub()).toContain('SeatReleasedEvent');
  });

  it('releaseExpired releases a still-reserved seat (attributed to the holder)', async () => {
    base.seats = [seat(1, { status: VideoRoomSeatStatus.RESERVED, reservedForUserId: 'guest' })];
    const released = await svc.releaseExpired('r', 1);
    expect(released).toBe(true);
    expect(deps.seats.updateSeat).toHaveBeenCalledWith(
      'r',
      1,
      expect.objectContaining({ seatStatus: VideoRoomSeatStatus.EMPTY }),
      'guest',
    );
    expect(pub()).toContain('SeatReleasedEvent');
  });

  it('releaseExpired is a no-op when the seat is no longer reserved', async () => {
    base.seats = [seat(1, { status: VideoRoomSeatStatus.OCCUPIED, occupantUserId: 'guest' })];
    const released = await svc.releaseExpired('r', 1);
    expect(released).toBe(false);
    expect(deps.seats.updateSeat).not.toHaveBeenCalled();
  });
});
