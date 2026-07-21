import { VideoRoomSeatMonitor } from './video-room-seat.monitor';

describe('VideoRoomSeatMonitor', () => {
  let deps: any;
  let monitor: VideoRoomSeatMonitor;

  beforeEach(() => {
    deps = {
      seats: {
        expireStaleRequests: jest.fn().mockResolvedValue(0),
        expireStaleInvitations: jest.fn().mockResolvedValue(0),
        listExpiredRequests: jest.fn().mockResolvedValue([]),
        listExpiredInvitations: jest.fn().mockResolvedValue([]),
        setRequestStatus: jest.fn(),
        setInvitationStatus: jest.fn(),
        listReservedSeats: jest.fn().mockResolvedValue([]),
      },
      reservations: { releaseExpired: jest.fn().mockResolvedValue(true) },
      cache: { get: jest.fn() },
      locks: { acquire: jest.fn().mockResolvedValue(async () => undefined) },
      config: { get: jest.fn().mockReturnValue({ cleanupIntervalSeconds: 30 }) },
      queue: { dequeue: jest.fn(), publishUpdate: jest.fn().mockResolvedValue(undefined) },
      bus: { publish: jest.fn() },
    };
    monitor = new VideoRoomSeatMonitor(
      deps.seats,
      deps.reservations,
      deps.cache,
      deps.locks,
      deps.config,
      deps.queue,
      deps.bus,
    );
  });

  it('expires stale requests + invitations and reconciles reserved holds under the lock', async () => {
    deps.seats.listExpiredRequests.mockResolvedValue([{ id: 'q1', roomId: 'r1', userId: 'u1' }]);
    deps.seats.listExpiredInvitations.mockResolvedValue([
      { id: 'i1', roomId: 'r1', inviteeUserId: 'u2' },
    ]);
    deps.seats.listReservedSeats.mockResolvedValue([{ roomId: 'r', seatIndex: 2 }]);
    deps.cache.get.mockResolvedValue(null); // the Redis hold has expired
    await (monitor as any).sweep();
    expect(deps.seats.listExpiredRequests).toHaveBeenCalled();
    expect(deps.seats.listExpiredInvitations).toHaveBeenCalled();
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
    expect(deps.seats.listExpiredRequests).not.toHaveBeenCalled();
  });
});

describe('VideoRoomSeatMonitor — VR-8 per-row expiry', () => {
  let deps: any;
  let monitor: VideoRoomSeatMonitor;

  const runSweep = () => (monitor as any).sweep();

  beforeEach(() => {
    deps = {
      seats: {
        listExpiredRequests: jest.fn().mockResolvedValue([]),
        listExpiredInvitations: jest.fn().mockResolvedValue([]),
        setRequestStatus: jest.fn(),
        setInvitationStatus: jest.fn(),
        listReservedSeats: jest.fn().mockResolvedValue([]),
      },
      reservations: { releaseExpired: jest.fn().mockResolvedValue(false) },
      cache: { get: jest.fn().mockResolvedValue(null) },
      locks: { acquire: jest.fn().mockResolvedValue(async () => undefined) },
      config: { get: jest.fn().mockReturnValue({ cleanupIntervalSeconds: 30 }) },
      queue: { dequeue: jest.fn(), publishUpdate: jest.fn().mockResolvedValue(undefined) },
      bus: { publish: jest.fn() },
    };
    monitor = new VideoRoomSeatMonitor(
      deps.seats,
      deps.reservations,
      deps.cache,
      deps.locks,
      deps.config,
      deps.queue,
      deps.bus,
    );
  });

  it('publishes one expiry event per expired request', async () => {
    deps.seats.listExpiredRequests.mockResolvedValue([
      { id: 'q1', roomId: 'r1', userId: 'u1' },
      { id: 'q2', roomId: 'r1', userId: 'u2' },
    ]);
    await runSweep();
    const names = deps.bus.publish.mock.calls.map((c: any[]) => c[0].name);
    expect(names.filter((n: string) => n === 'video_room.seat_request_expired')).toHaveLength(2);
  });

  it('marks each expired request EXPIRED in the database', async () => {
    deps.seats.listExpiredRequests.mockResolvedValue([{ id: 'q1', roomId: 'r1', userId: 'u1' }]);
    await runSweep();
    expect(deps.seats.setRequestStatus).toHaveBeenCalledWith(
      'q1',
      'EXPIRED',
      expect.any(String),
      expect.any(String),
    );
  });

  it('removes each expired requester from the queue', async () => {
    deps.seats.listExpiredRequests.mockResolvedValue([{ id: 'q1', roomId: 'r1', userId: 'u1' }]);
    await runSweep();
    expect(deps.queue.dequeue).toHaveBeenCalledWith('r1', 'u1');
  });

  it('publishes one expiry event per expired invitation', async () => {
    deps.seats.listExpiredInvitations.mockResolvedValue([
      { id: 'i1', roomId: 'r1', inviteeUserId: 'u2' },
    ]);
    await runSweep();
    const names = deps.bus.publish.mock.calls.map((c: any[]) => c[0].name);
    expect(names).toContain('video_room.seat_invitation_expired');
  });

  it('bounds each collection by the sweep limit', async () => {
    await runSweep();
    expect(deps.seats.listExpiredRequests).toHaveBeenCalledWith(expect.any(Date), 500);
    expect(deps.seats.listExpiredInvitations).toHaveBeenCalledWith(expect.any(Date), 500);
  });

  it('does nothing when another instance holds the sweep lock', async () => {
    deps.locks.acquire.mockResolvedValue(null);
    await runSweep();
    expect(deps.seats.listExpiredRequests).not.toHaveBeenCalled();
  });

  it('publishes nothing when there is nothing to expire', async () => {
    await runSweep();
    expect(deps.bus.publish).not.toHaveBeenCalled();
  });

  it('keeps sweeping after one row fails', async () => {
    deps.seats.listExpiredRequests.mockResolvedValue([
      { id: 'q1', roomId: 'r1', userId: 'u1' },
      { id: 'q2', roomId: 'r1', userId: 'u2' },
    ]);
    deps.seats.setRequestStatus.mockRejectedValueOnce(new Error('row gone'));
    await runSweep();
    expect(deps.seats.setRequestStatus).toHaveBeenCalledTimes(2);
  });

  // Regression for the critical bug: 'system' is not a valid UUID, and every
  // audit column these writes land in (`resolvedBy`/`updatedBy`/`actorId`) is
  // `@db.Uuid` — Postgres throws on the literal string, silently, because the
  // sweep swallows-and-logs. A UUID-shaped sentinel is the fix; assert the
  // shape rather than any specific mocked return value, so a regression to any
  // non-UUID literal (not just 'system') is caught.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('records a UUID actor id on the sweep-driven request expiry, not the literal string "system"', async () => {
    deps.seats.listExpiredRequests.mockResolvedValue([{ id: 'q1', roomId: 'r1', userId: 'u1' }]);
    await runSweep();
    const [, , resolvedBy, updatedBy] = deps.seats.setRequestStatus.mock.calls[0];
    expect(resolvedBy).toMatch(UUID_RE);
    expect(updatedBy).toMatch(UUID_RE);
  });

  it('records a UUID actor id on the sweep-driven invitation expiry, not the literal string "system"', async () => {
    deps.seats.listExpiredInvitations.mockResolvedValue([
      { id: 'i1', roomId: 'r1', inviteeUserId: 'u2' },
    ]);
    await runSweep();
    const [, , updatedBy] = deps.seats.setInvitationStatus.mock.calls[0];
    expect(updatedBy).toMatch(UUID_RE);
  });
});
