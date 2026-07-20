import { VideoRoomSeatMonitor } from './video-room-seat.monitor';

describe('VideoRoomSeatMonitor', () => {
  let deps: any;
  let monitor: VideoRoomSeatMonitor;

  beforeEach(() => {
    deps = {
      seats: {
        expireStaleRequests: jest.fn().mockResolvedValue(0),
        expireStaleInvitations: jest.fn().mockResolvedValue(0),
        listReservedSeats: jest.fn().mockResolvedValue([]),
      },
      reservations: { releaseExpired: jest.fn().mockResolvedValue(true) },
      cache: { get: jest.fn() },
      locks: { acquire: jest.fn().mockResolvedValue(async () => undefined) },
      config: { get: jest.fn().mockReturnValue({ cleanupIntervalSeconds: 30 }) },
    };
    monitor = new VideoRoomSeatMonitor(
      deps.seats,
      deps.reservations,
      deps.cache,
      deps.locks,
      deps.config,
    );
  });

  it('expires stale requests + invitations and reconciles reserved holds under the lock', async () => {
    deps.seats.listReservedSeats.mockResolvedValue([{ roomId: 'r', seatIndex: 2 }]);
    deps.cache.get.mockResolvedValue(null); // the Redis hold has expired
    await (monitor as any).sweep();
    expect(deps.seats.expireStaleRequests).toHaveBeenCalled();
    expect(deps.seats.expireStaleInvitations).toHaveBeenCalled();
    expect(deps.reservations.releaseExpired).toHaveBeenCalledWith('r', 2);
  });

  it('keeps a reservation whose hold is still present', async () => {
    deps.seats.listReservedSeats.mockResolvedValue([{ roomId: 'r', seatIndex: 2 }]);
    deps.cache.get.mockResolvedValue({ forUserId: 'guest' }); // hold still alive
    await (monitor as any).sweep();
    expect(deps.reservations.releaseExpired).not.toHaveBeenCalled();
  });

  it('no-ops when another instance holds the sweep lock', async () => {
    deps.locks.acquire.mockResolvedValue(null);
    await (monitor as any).sweep();
    expect(deps.seats.expireStaleRequests).not.toHaveBeenCalled();
  });
});
