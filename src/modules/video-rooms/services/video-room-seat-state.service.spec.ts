import { VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';
import type { SeatStageSnapshot } from '../interfaces/seat-stage.interface';
import { VideoRoomSeatStateService } from './video-room-seat-state.service';

describe('VideoRoomSeatStateService', () => {
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let repo: { listSeats: jest.Mock; getSeatLayout: jest.Mock; createLayout: jest.Mock };
  let svc: VideoRoomSeatStateService;

  /** A durable seat row as `listSeats` returns it. */
  const seatRow = (
    seatIndex: number,
    seatType: VideoRoomSeatType,
    over: Record<string, unknown> = {},
  ) => ({
    seatIndex,
    seatType,
    seatStatus: VideoRoomSeatStatus.EMPTY,
    occupantUserId: null,
    reservedForUserId: null,
    isLocked: false,
    isMuted: false,
    isVideoOn: false,
    metadata: null,
    ...over,
  });

  beforeEach(() => {
    cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
    repo = {
      listSeats: jest.fn(),
      getSeatLayout: jest.fn(),
      createLayout: jest.fn().mockResolvedValue(0),
    };
    const config = { get: jest.fn().mockReturnValue({ stateTtlSeconds: 300 }) };
    svc = new VideoRoomSeatStateService(cache as never, repo as never, config as never);
  });

  it('getSnapshot reads the versioned key', async () => {
    cache.get.mockResolvedValue({ roomId: 'r1', version: 2 });
    await svc.getSnapshot('r1');
    expect(cache.get).toHaveBeenCalledWith('video-room:{r1}:seats');
  });

  it('rebuild() builds a version-1 snapshot from DB seats + layout and caches it', async () => {
    repo.getSeatLayout.mockResolvedValue({
      hostSeatCount: 2,
      guestSeatCount: 0,
      hasSettings: true,
    });
    repo.listSeats.mockResolvedValue([seatRow(0, VideoRoomSeatType.OWNER)]);
    const snap = await svc.rebuild('r1');
    expect(snap.version).toBe(1);
    expect(snap.hostSeatCount).toBe(2);
    expect(snap.seats).toHaveLength(1);
    expect(cache.set).toHaveBeenCalledWith('video-room:{r1}:seats', snap, 300);
  });

  // ---- Self-healing backfill: settings declared a layout, no seat rows exist ----

  it('rebuild() materialises the declared layout when the room has zero seat rows', async () => {
    repo.getSeatLayout.mockResolvedValue({
      hostSeatCount: 9,
      guestSeatCount: 0,
      hasSettings: true,
    });
    const materialised = [
      seatRow(0, VideoRoomSeatType.OWNER),
      ...Array.from({ length: 9 }, (_, i) => seatRow(i + 1, VideoRoomSeatType.HOST)),
    ];
    repo.listSeats.mockResolvedValueOnce([]).mockResolvedValueOnce(materialised);

    const snap = await svc.rebuild('r1');

    // Wrote exactly the 10-seat layout, with no acting user (system backfill).
    expect(repo.createLayout).toHaveBeenCalledTimes(1);
    const [roomId, layout, actorId] = repo.createLayout.mock.calls[0];
    expect(roomId).toBe('r1');
    expect(actorId).toBeNull();
    expect(layout).toHaveLength(10);
    expect(layout[0]).toEqual({ seatIndex: 0, seatType: VideoRoomSeatType.OWNER });
    expect(layout.slice(1).every((s: { seatType: string }) => s.seatType === 'HOST')).toBe(true);
    // …re-read and projected, so the caller sees the seats immediately.
    expect(repo.listSeats).toHaveBeenCalledTimes(2);
    expect(snap.seats).toHaveLength(10);
    expect(snap.seats[0].seatType).toBe(VideoRoomSeatType.OWNER);
    expect(snap.seats[9].seatType).toBe(VideoRoomSeatType.HOST);
    expect(snap.seats.every((s) => s.status === VideoRoomSeatStatus.EMPTY)).toBe(true);
  });

  it('rebuild() does NOT re-create seats for a room that already has rows', async () => {
    repo.getSeatLayout.mockResolvedValue({
      hostSeatCount: 9,
      guestSeatCount: 0,
      hasSettings: true,
    });
    repo.listSeats.mockResolvedValue([seatRow(0, VideoRoomSeatType.OWNER)]);

    await svc.rebuild('r1');

    expect(repo.createLayout).not.toHaveBeenCalled();
    expect(repo.listSeats).toHaveBeenCalledTimes(1);
  });

  it('rebuild() does not write seats for a room with no settings row (unknown room id)', async () => {
    repo.getSeatLayout.mockResolvedValue({
      hostSeatCount: 9,
      guestSeatCount: 0,
      hasSettings: false,
    });
    repo.listSeats.mockResolvedValue([]);

    const snap = await svc.rebuild('missing');

    expect(repo.createLayout).not.toHaveBeenCalled();
    expect(snap.seats).toEqual([]);
  });

  it('rebuild() does not write seats when the room declares no host/guest seats', async () => {
    repo.getSeatLayout.mockResolvedValue({
      hostSeatCount: 0,
      guestSeatCount: 0,
      hasSettings: true,
    });
    repo.listSeats.mockResolvedValue([]);

    await svc.rebuild('r1');

    expect(repo.createLayout).not.toHaveBeenCalled();
  });

  it('commit() bumps the version and persists the merged snapshot', async () => {
    const base: SeatStageSnapshot = {
      roomId: 'r1',
      version: 4,
      updatedAt: 't',
      hostSeatCount: 2,
      guestSeatCount: 0,
      seats: [],
    };
    const next = await svc.commit('r1', base, {
      seats: [
        {
          seatIndex: 1,
          seatType: VideoRoomSeatType.HOST,
          status: VideoRoomSeatStatus.OCCUPIED,
          occupantUserId: 'u',
          reservedForUserId: null,
          isLocked: false,
          isMuted: false,
          isVideoOn: false,
          reason: null,
          premium: false,
        },
      ],
    });
    expect(next.version).toBe(5);
    expect(next.seats).toHaveLength(1);
    expect(cache.set).toHaveBeenCalledWith('video-room:{r1}:seats', next, 300);
  });

  it('clear() deletes the snapshot key', async () => {
    await svc.clear('r1');
    expect(cache.del).toHaveBeenCalledWith('video-room:{r1}:seats');
  });
});
