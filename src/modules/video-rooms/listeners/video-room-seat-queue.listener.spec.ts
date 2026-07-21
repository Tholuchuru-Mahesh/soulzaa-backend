import { VIDEO_ROOM_SEAT_EVENTS } from '../events/video-room-seat.events';
import { VideoRoomSeatQueueListener } from './video-room-seat-queue.listener';

/**
 * LEFT/RELEASED handlers must return synchronously and defer their work via
 * `setImmediate` (see the listener's class doc) so the seat lock the publisher
 * still holds gets released before we re-enter `mutateStage`. Tests for those
 * two events must let the deferred callback run before asserting, or they pass
 * vacuously without ever exercising the handler body.
 */
const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('VideoRoomSeatQueueListener', () => {
  let deps: any;
  let listener: VideoRoomSeatQueueListener;
  let handlers: Record<string, (e: any) => Promise<void> | void>;

  beforeEach(() => {
    handlers = {};
    deps = {
      bus: {
        subscribe: jest.fn((type: string, fn: (e: any) => Promise<void> | void) => {
          handlers[type] = fn;
        }),
      },
      queue: {
        advance: jest.fn().mockResolvedValue('u1'),
        dequeue: jest.fn(),
        clear: jest.fn(),
        publishUpdate: jest.fn(),
      },
      requests: { restore: jest.fn().mockResolvedValue(null) },
      rooms: { getSettings: jest.fn().mockResolvedValue({ seatApprovalRequired: false }) },
      seats: { resolveAllPendingRequestsForUser: jest.fn() },
    };
    listener = new VideoRoomSeatQueueListener(
      deps.bus,
      deps.queue,
      deps.requests,
      deps.rooms,
      deps.seats,
    );
    listener.onModuleInit();
  });

  it('auto-advances onto a freed seat when the room does not require approval', async () => {
    await handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 3 } });
    await flushImmediates();
    expect(deps.queue.advance).toHaveBeenCalledWith('r1', 3, expect.any(String));
  });

  // Regression for the critical bug: the actor recorded on an auto-advance
  // seating must be a valid UUID. `queue.advance` threads this id straight
  // into `VideoRoomSeatRequest.resolvedBy`/`updatedBy` (both `@db.Uuid`), so
  // the literal string 'system' throws at the query layer — silently, since
  // every handler here is wrapped in `guard` (log + swallow).
  it('passes a UUID-shaped actor id to advance, not the literal string "system"', async () => {
    await handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 3 } });
    await flushImmediates();
    const actorArg = deps.queue.advance.mock.calls[0][2];
    expect(actorArg).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('does NOT auto-advance when the room requires approval — it only refreshes the queue', async () => {
    deps.rooms.getSettings.mockResolvedValue({ seatApprovalRequired: true });
    await handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 3 } });
    await flushImmediates();
    expect(deps.queue.advance).not.toHaveBeenCalled();
    expect(deps.queue.publishUpdate).toHaveBeenCalledWith('r1');
  });

  it('defaults to approval-required when a room has no settings row', async () => {
    deps.rooms.getSettings.mockResolvedValue(null);
    await handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 3 } });
    await flushImmediates();
    expect(deps.queue.advance).not.toHaveBeenCalled();
    // Proves the deferred callback actually ran the null-settings branch, rather
    // than this assertion passing vacuously because nothing ran at all.
    expect(deps.queue.publishUpdate).toHaveBeenCalledWith('r1');
  });

  it('auto-advances on a released reservation too', async () => {
    await handlers[VIDEO_ROOM_SEAT_EVENTS.RELEASED]({ payload: { roomId: 'r1', seatIndex: 4 } });
    await flushImmediates();
    expect(deps.queue.advance).toHaveBeenCalledWith('r1', 4, expect.any(String));
  });

  it('never auto-advances onto the owner seat', async () => {
    // Baseline first: a normal seat DOES reach `advance` once the deferred
    // callback runs — this is what proves the second assertion isn't vacuous.
    await handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 3 } });
    await flushImmediates();
    expect(deps.queue.advance).toHaveBeenCalledTimes(1);

    await handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 0 } });
    await flushImmediates();
    expect(deps.queue.advance).toHaveBeenCalledTimes(1); // unchanged — owner seat is never queued for
  });

  it('dequeues a user who has just been seated', async () => {
    await handlers[VIDEO_ROOM_SEAT_EVENTS.TAKEN]({
      payload: { roomId: 'r1', userId: 'u1', seatIndex: 2 },
    });
    expect(deps.queue.dequeue).toHaveBeenCalledWith('r1', 'u1');
  });

  // Fix I3: seating via takeSeat/transferSeat/switchSeat (any route that
  // ends in SeatTakenEvent, not just approve/advance) leaves a PENDING
  // request row behind unless it's resolved here too — otherwise a Redis
  // rebuild replays the seated user right back into the queue.
  it('resolves the seated user’s PENDING request row to PROMOTED, with the system actor', async () => {
    await handlers[VIDEO_ROOM_SEAT_EVENTS.TAKEN]({
      payload: { roomId: 'r1', userId: 'u1', seatIndex: 2 },
    });
    expect(deps.seats.resolveAllPendingRequestsForUser).toHaveBeenCalledWith(
      'r1',
      'u1',
      'PROMOTED',
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    );
  });

  it('dequeues a user who leaves the room', async () => {
    await handlers['video_room.user_left']({ payload: { roomId: 'r1', userId: 'u1' } });
    expect(deps.queue.dequeue).toHaveBeenCalledWith('r1', 'u1');
  });

  // Fix I3: same phantom-entry risk as SeatTakenEvent — a departed user's
  // PENDING request row must be cancelled, not merely dequeued from Redis.
  it('cancels a departed user’s PENDING request row, with the system actor', async () => {
    await handlers['video_room.user_left']({ payload: { roomId: 'r1', userId: 'u1' } });
    expect(deps.seats.resolveAllPendingRequestsForUser).toHaveBeenCalledWith(
      'r1',
      'u1',
      'CANCELLED',
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    );
  });

  it('restores a reconnecting user’s expired request', async () => {
    await handlers['video_room.user_reconnected']({ payload: { roomId: 'r1', userId: 'u1' } });
    expect(deps.requests.restore).toHaveBeenCalledWith('r1', 'u1');
  });

  it('clears the whole projection when the room closes', async () => {
    await handlers['video_room.closed']({ payload: { roomId: 'r1' } });
    expect(deps.queue.clear).toHaveBeenCalledWith('r1');
  });

  it('swallows a queue failure so one bad advance cannot kill the event bus', async () => {
    deps.queue.advance.mockRejectedValue(new Error('redis down'));
    const onUnhandledRejection = jest.fn();
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      // The handler itself must return synchronously (it only schedules the
      // deferred work) — calling it must not throw or return a rejected promise.
      expect(() =>
        handlers[VIDEO_ROOM_SEAT_EVENTS.LEFT]({ payload: { roomId: 'r1', seatIndex: 3 } }),
      ).not.toThrow();
      // Give the deferred setImmediate callback (and its rejected promise) a
      // chance to run/settle before we check nothing leaked out as unhandled.
      await flushImmediates();
      await flushImmediates();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
    // Proves the deferred callback actually attempted the advance (and thus
    // actually hit the rejection) rather than this test passing vacuously.
    expect(deps.queue.advance).toHaveBeenCalled();
    expect(onUnhandledRejection).not.toHaveBeenCalled();
  });
});
