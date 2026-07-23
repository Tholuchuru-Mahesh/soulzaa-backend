import { HttpStatus } from '@nestjs/common';
import { VideoRoomSeatRequestStatus } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomSeatRequestService } from './video-room-seat-request.service';

const actor = (id: string) => ({ id, roles: [] as never[] });

// Hoisted to file scope (rather than nested in a single describe) so every
// describe block below — pre-existing and VR-8 — shares one `beforeEach`.
let deps: any;
let svc: VideoRoomSeatRequestService;

beforeEach(() => {
  deps = {
    seatSvc: {
      requireLiveRoom: jest.fn().mockResolvedValue({ id: 'r', ownerId: 'owner' }),
      seatUser: jest.fn().mockResolvedValue({ roomId: 'r', version: 3, seats: [] }),
      getStage: jest.fn(),
      findOpenSeat: jest.fn().mockResolvedValue(0),
    },
    seats: {
      findPendingRequest: jest.fn().mockResolvedValue(null),
      findOccupiedSeat: jest.fn().mockResolvedValue(null),
      findSeat: jest.fn().mockResolvedValue({ seatIndex: 0, isLocked: false, seatStatus: 'EMPTY' }),
      createRequest: jest.fn().mockResolvedValue({
        id: 'q1',
        seatIndex: 2,
        status: 'PENDING',
        createdAt: new Date(),
        userId: 'u',
      }),
      listPendingRequests: jest.fn().mockResolvedValue([]),
      // I6 — the CAS path treats a falsy return as "lost the race", so the
      // default double as a real repository would: succeed and echo the row.
      setRequestStatus: jest
        .fn()
        .mockImplementation((id: string, status: VideoRoomSeatRequestStatus) =>
          Promise.resolve({ id, status }),
        ),
      findRequestById: jest.fn(),
      findLatestRequestForUser: jest.fn().mockResolvedValue(null),
      restoreRequest: jest.fn(),
    },
    rooms: { getMember: jest.fn().mockResolvedValue({ isActive: true }) },
    permissions: { assertPermission: jest.fn(), authorityRank: jest.fn().mockResolvedValue(0) },
    events: { appendEvent: jest.fn() },
    bus: { publish: jest.fn() },
    moderation: { isActivelyBlocked: jest.fn().mockResolvedValue(false) },
    queue: {
      enqueue: jest.fn().mockResolvedValue(1),
      dequeue: jest.fn(),
      position: jest.fn().mockResolvedValue(1),
      publishUpdate: jest.fn(),
    },
  };
  svc = new VideoRoomSeatRequestService(
    deps.seatSvc,
    deps.seats,
    deps.rooms,
    deps.permissions,
    deps.events,
    deps.bus,
    deps.moderation,
    deps.queue,
  );
});

const pub = () => deps.bus.publish.mock.calls.map((c: any[]) => c[0].constructor.name);
const publishedPayload = (name: string) =>
  deps.bus.publish.mock.calls.find((c: any[]) => c[0].constructor.name === name)?.[0].payload;

describe('VideoRoomSeatRequestService', () => {
  it('request creates a PENDING request with expiry and publishes', async () => {
    await svc.request(actor('u'), 'r', 2);
    expect(deps.seats.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r',
        userId: 'u',
        seatIndex: 2,
        expiresAt: expect.any(Date),
      }),
      'u',
    );
    expect(pub()).toContain('SeatRequestedEvent');
  });

  it('request rejects a duplicate pending request (DUPLICATE_SEAT_REQUEST)', async () => {
    deps.seats.findPendingRequest.mockResolvedValue({ id: 'existing' });
    await expect(svc.request(actor('u'), 'r', 2)).rejects.toMatchObject({
      errorCode: ERROR_CODES.DUPLICATE_SEAT_REQUEST,
    });
  });

  it('approve requires MANAGE_SEATS, seats the requester, marks ACCEPTED', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r',
      userId: 'requester',
      seatIndex: 2,
      status: VideoRoomSeatRequestStatus.PENDING,
      expiresAt: null,
      createdAt: new Date(),
    });
    await svc.approve(actor('owner'), 'r', 'q1');
    expect(deps.permissions.assertPermission).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'MANAGE_SEATS',
    );
    expect(deps.seatSvc.seatUser).toHaveBeenCalledWith('r', 'requester', 'owner', 2, undefined);
    // I6 — the ACCEPTED write is now a compare-and-swap CAS'd on the PENDING
    // this call read (see `transitionRequest`).
    expect(deps.seats.setRequestStatus).toHaveBeenCalledWith(
      'q1',
      VideoRoomSeatRequestStatus.ACCEPTED,
      'owner',
      'owner',
      { expectedFrom: VideoRoomSeatRequestStatus.PENDING },
    );
    expect(pub()).toContain('SeatRequestResolvedEvent');
    expect(publishedPayload('SeatRequestResolvedEvent')).toMatchObject({
      requestId: 'q1',
      status: 'PROMOTED',
    });
  });

  it('reject marks the request REJECTED', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r',
      userId: 'requester',
      seatIndex: 2,
      status: VideoRoomSeatRequestStatus.PENDING,
      expiresAt: null,
      createdAt: new Date(),
    });
    await svc.reject(actor('owner'), 'r', 'q1');
    // I6 — CAS'd on the PENDING this call read (see `transitionRequest`).
    expect(deps.seats.setRequestStatus).toHaveBeenCalledWith(
      'q1',
      VideoRoomSeatRequestStatus.REJECTED,
      'owner',
      'owner',
      { expectedFrom: VideoRoomSeatRequestStatus.PENDING },
    );
    expect(pub()).toContain('SeatRequestResolvedEvent');
    expect(publishedPayload('SeatRequestResolvedEvent')).toMatchObject({
      requestId: 'q1',
      status: 'REJECTED',
    });
  });

  it("cancelRequest marks the caller's own request CANCELLED and publishes", async () => {
    deps.seats.findPendingRequest.mockResolvedValue({
      id: 'q1',
      roomId: 'r',
      userId: 'u',
      seatIndex: 2,
      status: VideoRoomSeatRequestStatus.PENDING,
      expiresAt: null,
    });
    await svc.cancelRequest(actor('u'), 'r');
    // I6 — CAS'd on the PENDING this call read (see `transitionRequest`).
    expect(deps.seats.setRequestStatus).toHaveBeenCalledWith(
      'q1',
      VideoRoomSeatRequestStatus.CANCELLED,
      'u',
      'u',
      { expectedFrom: VideoRoomSeatRequestStatus.PENDING },
    );
    expect(pub()).toContain('SeatRequestResolvedEvent');
    expect(publishedPayload('SeatRequestResolvedEvent')).toMatchObject({
      requestId: 'q1',
      status: 'CANCELLED',
    });
  });

  // VR-8 superseded the read-time `compareRequestPriority` comparator with
  // queue-position ordering (see `describe('listRequests', ...)` below for the
  // position field itself). This test is adapted rather than deleted: it keeps
  // proving "earlier requester comes first", but now drives that through
  // `queue.position` — the actual source of ordering in the new `listRequests` —
  // instead of relying on `compareRequestPriority`'s createdAt comparison.
  it('listRequests returns views ordered by queue position (not raw repository order)', async () => {
    const older = {
      id: 'a',
      userId: 'a',
      seatIndex: 1,
      status: 'PENDING',
      createdAt: new Date(1000),
    };
    const newer = {
      id: 'b',
      userId: 'b',
      seatIndex: 2,
      status: 'PENDING',
      createdAt: new Date(2000),
    };
    deps.seats.listPendingRequests.mockResolvedValue([newer, older]);
    deps.queue.position.mockImplementation((_roomId: string, userId: string) =>
      Promise.resolve(userId === 'a' ? 1 : 2),
    );
    const list = await svc.listRequests(actor('owner'), 'r');
    expect(list.map((r) => r.id)).toEqual(['a', 'b']); // lower queue position first
  });
});

describe('request validations (VR-8)', () => {
  it('refuses a user blocked from the room', async () => {
    deps.moderation.isActivelyBlocked.mockResolvedValue(true);
    await expect(svc.request(actor('u1'), 'r1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_BLOCKED,
    });
  });

  it('refuses a user who already holds a seat', async () => {
    deps.seats.findOccupiedSeat = jest.fn().mockResolvedValue({ seatIndex: 2 });
    await expect(svc.request(actor('u1'), 'r1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.ALREADY_ON_SEAT,
    });
  });

  it('refuses a request for a locked seat', async () => {
    deps.seats.findSeat = jest.fn().mockResolvedValue({ seatIndex: 3, isLocked: true });
    await expect(svc.request(actor('u1'), 'r1', 3)).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_LOCKED,
    });
  });

  it('refuses a request for a seat index that does not exist', async () => {
    deps.seats.findSeat = jest.fn().mockResolvedValue(null);
    await expect(svc.request(actor('u1'), 'r1', 99)).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_NOT_FOUND,
    });
  });

  it('refuses a request for a reserved seat', async () => {
    deps.seats.findSeat = jest
      .fn()
      .mockResolvedValue({ seatIndex: 3, isLocked: false, seatStatus: 'RESERVED' });
    await expect(svc.request(actor('u1'), 'r1', 3)).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_RESERVED,
    });
  });

  it('enqueues the requester once the request row is created', async () => {
    await svc.request(actor('u1'), 'r1');
    expect(deps.queue.enqueue).toHaveBeenCalledWith('r1', 'u1', expect.any(Date));
  });

  it('still refuses a duplicate pending request', async () => {
    deps.seats.findPendingRequest.mockResolvedValue({ id: 'existing' });
    await expect(svc.request(actor('u1'), 'r1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.DUPLICATE_SEAT_REQUEST,
    });
  });
});

describe('approve → PROMOTED / FAILED', () => {
  beforeEach(() => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      seatIndex: 2,
      status: 'PENDING',
      attemptCount: 0,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  it('marks the request PROMOTED after a successful seating', async () => {
    await svc.approve(actor('owner'), 'r1', 'q1');
    const statuses = deps.seats.setRequestStatus.mock.calls.map((c: any[]) => c[1]);
    expect(statuses).toContain('PROMOTED');
    expect(pub()).toContain('SeatRequestResolvedEvent');
    expect(publishedPayload('SeatRequestResolvedEvent')).toMatchObject({
      requestId: 'q1',
      status: 'PROMOTED',
    });
  });

  it('removes the promoted user from the queue', async () => {
    await svc.approve(actor('owner'), 'r1', 'q1');
    expect(deps.queue.dequeue).toHaveBeenCalledWith('r1', 'u1');
  });

  it('marks the request FAILED and rethrows when seating throws a business error', async () => {
    deps.seatSvc.seatUser.mockRejectedValue(
      new BusinessException(ERROR_CODES.SEAT_TAKEN, 'seat taken', HttpStatus.CONFLICT),
    );
    await expect(svc.approve(actor('owner'), 'r1', 'q1')).rejects.toThrow('seat taken');
    const failed = deps.seats.setRequestStatus.mock.calls.find((c: any[]) => c[1] === 'FAILED');
    expect(failed).toBeDefined();
    expect(failed[4]).toMatchObject({ bumpAttempt: true, lastError: 'seat taken' });
    expect(pub()).toContain('SeatRequestResolvedEvent');
    expect(publishedPayload('SeatRequestResolvedEvent')).toMatchObject({
      requestId: 'q1',
      status: 'FAILED',
    });
  });

  // Fix I4 — INVERTED from the previous assertion ("leaves a failed requester
  // in the queue"). A FAILED row has no Postgres-side "still pending" status,
  // so leaving it in the Redis queue was a lie the projection couldn't back
  // up: `rebuild()` (PENDING-only) would drop it on any Redis loss, and the
  // very next auto-`advance()` pass would find no matching PENDING request
  // and silently `sortedRemove` it anyway — the "stays queued for retry"
  // invariant was honoured in this one path and violated by the other two.
  // The requester is now dequeued on FAILED, and `retry()` re-enqueues them
  // at their original position (see the `retry` describe block below).
  it('dequeues a failed requester (retry is now responsible for re-enqueueing them)', async () => {
    deps.seatSvc.seatUser.mockRejectedValue(
      new BusinessException(ERROR_CODES.SEAT_TAKEN, 'seat taken', HttpStatus.CONFLICT),
    );
    await expect(svc.approve(actor('owner'), 'r1', 'q1')).rejects.toThrow();
    expect(deps.queue.dequeue).toHaveBeenCalledWith('r1', 'u1');
  });

  // Fix 4: a transient infra error (lock-acquisition failure, Redis/Postgres
  // blip) must not burn the request's 3-attempt budget — only a genuine
  // BusinessException (seat taken/locked/etc.) counts as a failed attempt.
  it('rethrows a non-business error WITHOUT marking FAILED, bumping the attempt count, or publishing a resolution', async () => {
    const infraError = new Error('ECONNREFUSED');
    deps.seatSvc.seatUser.mockRejectedValue(infraError);
    await expect(svc.approve(actor('owner'), 'r1', 'q1')).rejects.toBe(infraError);
    const failed = deps.seats.setRequestStatus.mock.calls.find((c: any[]) => c[1] === 'FAILED');
    expect(failed).toBeUndefined();
    expect(pub()).not.toContain('SeatRequestResolvedEvent');
    expect(deps.queue.dequeue).not.toHaveBeenCalled();
  });
});

// I6 — the concrete bug: two admins approve the same PENDING request
// concurrently. Both used to pass `requirePendingRequest`, both write
// ACCEPTED, both call `seatUser`; the loser's `seatUser` throws
// ALREADY_ON_SEAT and it wrote FAILED over the winner's PROMOTED — final
// state: user seated, row reads FAILED, room told "failed". These tests pin
// the fix: the ACCEPTED write is now a compare-and-swap, and losing it stops
// the second caller before `seatUser` is ever invoked.
describe('approve — I6 compare-and-swap race semantics', () => {
  beforeEach(() => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      seatIndex: 2,
      status: 'PENDING',
      attemptCount: 0,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  it('raises CONFLICT when another actor already moved the row off PENDING, and never calls seatUser', async () => {
    // Simulates the second of two concurrent approvers: the CAS `updateMany`
    // finds 0 rows (the first approver already flipped it to ACCEPTED), so
    // the repository reports the lost race.
    deps.seats.setRequestStatus.mockResolvedValueOnce(null);
    await expect(svc.approve(actor('owner'), 'r1', 'q1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_REQUEST_INVALID_TRANSITION,
      status: HttpStatus.CONFLICT,
    });
    expect(deps.seatSvc.seatUser).not.toHaveBeenCalled();
    // No FAILED write, no resolution event — the loser's attempt budget and
    // the room's event stream are both left untouched by the lost race.
    expect(deps.seats.setRequestStatus).toHaveBeenCalledTimes(1);
    expect(pub()).not.toContain('SeatRequestResolvedEvent');
  });

  it('raises the same CONFLICT for a concurrent reject that loses the race', async () => {
    deps.seats.setRequestStatus.mockResolvedValueOnce(null);
    await expect(svc.reject(actor('owner'), 'r1', 'q1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_REQUEST_INVALID_TRANSITION,
      status: HttpStatus.CONFLICT,
    });
    expect(deps.queue.dequeue).not.toHaveBeenCalled();
    expect(pub()).not.toContain('SeatRequestResolvedEvent');
  });

  it('raises the same CONFLICT for a concurrent cancelRequest that loses the race', async () => {
    deps.seats.findPendingRequest.mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      status: 'PENDING',
      createdAt: new Date(),
    });
    deps.seats.setRequestStatus.mockResolvedValueOnce(null);
    await expect(svc.cancelRequest(actor('u1'), 'r1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_REQUEST_INVALID_TRANSITION,
      status: HttpStatus.CONFLICT,
    });
    expect(deps.queue.dequeue).not.toHaveBeenCalled();
  });
});

describe('retry', () => {
  it('re-drives seating for a FAILED request', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      seatIndex: 2,
      status: 'FAILED',
      attemptCount: 1,
      createdAt: new Date(),
    });
    await svc.retry(actor('owner'), 'r1', 'q1');
    expect(deps.seatSvc.seatUser).toHaveBeenCalled();
  });

  it('refuses to retry a request that is not FAILED', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      status: 'PENDING',
      attemptCount: 0,
      createdAt: new Date(),
    });
    await expect(svc.retry(actor('owner'), 'r1', 'q1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_REQUEST_INVALID_TRANSITION,
    });
  });

  it('allows retry when attempts remain below the ceiling (attemptCount 2 of 3)', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      seatIndex: 2,
      status: 'FAILED',
      attemptCount: 2,
      createdAt: new Date(),
    });
    await svc.retry(actor('owner'), 'r1', 'q1');
    expect(deps.seatSvc.seatUser).toHaveBeenCalled();
  });

  it('refuses once the attempt budget is exhausted', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      status: 'FAILED',
      attemptCount: 3,
      createdAt: new Date(),
    });
    await expect(svc.retry(actor('owner'), 'r1', 'q1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_RETRY_EXHAUSTED,
    });
  });

  // Fix 3: `driveSeating`'s extraction from `approve` dropped `retry`'s expiry
  // re-check. With a 60s TTL, a FAILED request is almost certainly stale by
  // the time an operator retries it — seating the requester anyway would seat
  // someone who has moved on.
  it('refuses to retry a request whose expiresAt has passed (stale FAILED row)', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      seatIndex: 2,
      status: 'FAILED',
      attemptCount: 1,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(svc.retry(actor('owner'), 'r1', 'q1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_REQUEST_EXPIRED,
    });
    expect(deps.seatSvc.seatUser).not.toHaveBeenCalled();
  });

  // Fix I4 — `driveSeating`'s FAILED branch now dequeues the requester (see
  // the inverted test above), so `retry` must re-enqueue them when it flips
  // the row back to PENDING — and at their ORIGINAL createdAt, exactly like
  // `restore()`, so they resume their former queue position rather than
  // joining at the back.
  it("re-enqueues the requester at the request's original createdAt", async () => {
    const originalCreatedAt = new Date('2026-07-20T09:00:00Z');
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      seatIndex: 2,
      status: 'FAILED',
      attemptCount: 1,
      createdAt: originalCreatedAt,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await svc.retry(actor('owner'), 'r1', 'q1');
    expect(deps.queue.enqueue).toHaveBeenCalledWith('r1', 'u1', originalCreatedAt);
  });
});

describe('restore', () => {
  it('revives an expired request and preserves its original createdAt', async () => {
    const createdAt = new Date('2026-07-21T10:00:00Z');
    deps.seats.findLatestRequestForUser = jest.fn().mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      status: 'EXPIRED',
      createdAt,
      // Resolved (expired) moments ago — well inside the restore grace window.
      resolvedAt: new Date(Date.now() - 5_000),
    });
    deps.seats.restoreRequest = jest.fn().mockResolvedValue({
      id: 'q1',
      userId: 'u1',
      seatIndex: null,
      status: 'PENDING',
      createdAt,
    });
    await svc.restore('r1', 'u1');
    expect(deps.seats.restoreRequest).toHaveBeenCalledWith('q1', 'u1', expect.any(Date));
    // Re-enqueued at the ORIGINAL createdAt, so the ZSET score is unchanged.
    expect(deps.queue.enqueue).toHaveBeenCalledWith('r1', 'u1', createdAt);
  });

  it('returns null when there is nothing to restore', async () => {
    deps.seats.findLatestRequestForUser = jest.fn().mockResolvedValue(null);
    await expect(svc.restore('r1', 'u1')).resolves.toBeNull();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it('does not restore a request the user deliberately cancelled', async () => {
    deps.seats.findLatestRequestForUser = jest.fn().mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      status: 'CANCELLED',
      createdAt: new Date(),
    });
    await expect(svc.restore('r1', 'u1')).resolves.toBeNull();
  });

  it("does not restore a FAILED request (that is retry's job instead)", async () => {
    deps.seats.findLatestRequestForUser = jest.fn().mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      status: 'FAILED',
      createdAt: new Date(),
    });
    await expect(svc.restore('r1', 'u1')).resolves.toBeNull();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  // ---- Fix I8 — grace window + re-run entry validations ----

  it('does not restore an expired request resolved longer ago than the grace window (queue-jump exploit)', async () => {
    deps.seats.findLatestRequestForUser = jest.fn().mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      status: 'EXPIRED',
      createdAt: new Date('2026-07-21T08:00:00Z'),
      // Resolved (expired) an hour ago — the exploit: request, let it lapse,
      // linger, then reconnect to jump the queue at an hour-old createdAt.
      resolvedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await expect(svc.restore('r1', 'u1')).resolves.toBeNull();
    expect(deps.seats.restoreRequest).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it('does not restore a request for a user now blocked from the room', async () => {
    deps.seats.findLatestRequestForUser = jest.fn().mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      status: 'EXPIRED',
      createdAt: new Date(),
      resolvedAt: new Date(Date.now() - 1_000),
    });
    deps.moderation.isActivelyBlocked.mockResolvedValue(true);
    await expect(svc.restore('r1', 'u1')).resolves.toBeNull();
    expect(deps.seats.restoreRequest).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it('does not restore a request for a user who is already seated', async () => {
    deps.seats.findLatestRequestForUser = jest.fn().mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      status: 'EXPIRED',
      createdAt: new Date(),
      resolvedAt: new Date(Date.now() - 1_000),
    });
    deps.seats.findOccupiedSeat.mockResolvedValue({ seatIndex: 3 });
    await expect(svc.restore('r1', 'u1')).resolves.toBeNull();
    expect(deps.seats.restoreRequest).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it('propagates a non-BusinessException error from the eligibility checks (does not swallow infra errors)', async () => {
    deps.seats.findLatestRequestForUser = jest.fn().mockResolvedValue({
      id: 'q1',
      roomId: 'r1',
      userId: 'u1',
      status: 'EXPIRED',
      createdAt: new Date(),
      resolvedAt: new Date(Date.now() - 1_000),
    });
    const infraError = new Error('ECONNREFUSED');
    deps.rooms.getMember.mockRejectedValue(infraError);
    await expect(svc.restore('r1', 'u1')).rejects.toBe(infraError);
  });
});

describe('updateRequest', () => {
  it('changes the preferred seat on a pending request', async () => {
    deps.seats.findPendingRequest.mockResolvedValue({ id: 'q1', userId: 'u1', seatIndex: 2 });
    deps.seats.updateRequestSeatIndex = jest.fn().mockResolvedValue({
      id: 'q1',
      userId: 'u1',
      seatIndex: 5,
      status: 'PENDING',
      createdAt: new Date(),
    });
    const view = await svc.updateRequest(actor('u1'), 'r1', 5);
    expect(deps.seats.updateRequestSeatIndex).toHaveBeenCalledWith('q1', 5, 'u1');
    expect(view.seatIndex).toBe(5);
  });

  it('fails when the user has no pending request', async () => {
    deps.seats.findPendingRequest.mockResolvedValue(null);
    await expect(svc.updateRequest(actor('u1'), 'r1', 5)).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_REQUEST_NOT_FOUND,
    });
  });
});

describe('listRequests', () => {
  it('returns each pending request with its queue position', async () => {
    deps.seats.listPendingRequests.mockResolvedValue([
      { id: 'q1', userId: 'u1', seatIndex: null, status: 'PENDING', createdAt: new Date() },
    ]);
    deps.queue.position.mockResolvedValue(4);
    const rows = await svc.listRequests(actor('owner'), 'r1');
    expect(rows[0]).toMatchObject({ userId: 'u1', position: 4 });
  });
});
