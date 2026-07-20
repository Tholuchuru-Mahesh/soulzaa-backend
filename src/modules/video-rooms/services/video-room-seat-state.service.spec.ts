import { VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';
import type { SeatStageSnapshot } from '../interfaces/seat-stage.interface';
import { VideoRoomSeatStateService } from './video-room-seat-state.service';

describe('VideoRoomSeatStateService', () => {
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let repo: { listSeats: jest.Mock; getSeatLayout: jest.Mock };
  let svc: VideoRoomSeatStateService;

  beforeEach(() => {
    cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
    repo = { listSeats: jest.fn(), getSeatLayout: jest.fn() };
    const config = { get: jest.fn().mockReturnValue({ stateTtlSeconds: 300 }) };
    svc = new VideoRoomSeatStateService(cache as never, repo as never, config as never);
  });

  it('getSnapshot reads the versioned key', async () => {
    cache.get.mockResolvedValue({ roomId: 'r1', version: 2 });
    await svc.getSnapshot('r1');
    expect(cache.get).toHaveBeenCalledWith('video-room:{r1}:seats');
  });

  it('rebuild() builds a version-1 snapshot from DB seats + layout and caches it', async () => {
    repo.getSeatLayout.mockResolvedValue({ hostSeatCount: 2, guestSeatCount: 0 });
    repo.listSeats.mockResolvedValue([
      {
        seatIndex: 0,
        seatType: VideoRoomSeatType.OWNER,
        seatStatus: VideoRoomSeatStatus.EMPTY,
        occupantUserId: null,
        reservedForUserId: null,
        isLocked: false,
        isMuted: false,
        isVideoOn: false,
        metadata: null,
      },
    ]);
    const snap = await svc.rebuild('r1');
    expect(snap.version).toBe(1);
    expect(snap.hostSeatCount).toBe(2);
    expect(snap.seats).toHaveLength(1);
    expect(cache.set).toHaveBeenCalledWith('video-room:{r1}:seats', snap, 300);
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
