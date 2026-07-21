import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { VideoRoomSeatRequestStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  VIDEO_ROOM_OWNER_SEAT_INDEX,
  VIDEO_ROOM_SYSTEM_ACTOR_ID,
} from '../constants/video-room.constants';
import {
  VIDEO_ROOM_SEAT_EVENTS,
  type SeatLeftEvent,
  type SeatReleasedEvent,
  type SeatTakenEvent,
} from '../events/video-room-seat.events';
import {
  VIDEO_ROOM_EVENTS,
  type RoomClosedEvent,
  type RoomDeletedEvent,
  type UserLeftEvent,
  type UserReconnectedEvent,
} from '../events/video-room.events';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomSeatQueueService } from '../services/video-room-seat-queue.service';
import { VideoRoomSeatRequestService } from '../services/video-room-seat-request.service';

/**
 * VR-8 — the only place seat/room lifecycle changes touch the seat queue.
 *
 * Keeping this in a listener is what lets `VideoRoomSeatService` stay ignorant
 * of the queue entirely: it publishes the same events it always did, and the
 * queue reacts. Every handler is defensive — a queue failure is logged and
 * swallowed, because a Redis blip must not take down the event bus or fail the
 * seat operation that triggered it.
 *
 * `LEFT`/`RELEASED` are special: `VideoRoomSeatService.applyVacate` publishes
 * `SeatLeftEvent` from *inside* `mutateStage`'s `withLock(videoRoomSeatLockKey)`
 * block, and `InMemoryEventBus.publish` (`emitAsync`) awaits listeners on the
 * publisher's own stack. A handler that directly awaited `queue.advance` (which
 * reseats via `seatUser` → `mutateStage`) would try to re-acquire that same,
 * still-held, non-re-entrant seat lock and deadlock/retry-storm. So those two
 * subscriptions return synchronously and defer the actual work with
 * `setImmediate`.
 *
 * Why that is actually safe — the precise reason matters, because the obvious
 * one is wrong. `setImmediate` does NOT, by event-loop semantics alone,
 * guarantee it runs after the lock has been released: `withLock`'s
 * `finally { await release() }` is a fresh async Redis round-trip, and Node's
 * poll→check transition can run an already-scheduled immediate in the same
 * iteration, before that round-trip's reply arrives. The real invariant is
 * protocol-level: the platform shares ONE Redis connection (`REDIS_CLIENT`),
 * and Redis executes commands from a connection in the order they were sent.
 * The `release()` command is written to the socket during the stack unwind,
 * strictly before the deferred callback can send any re-acquire — so the lock
 * is already free by the time the re-acquire is evaluated.
 *
 * If that ever changes (e.g. a connection pool replaces the shared client),
 * this degrades to a bounded ~100ms lock retry rather than a deadlock, because
 * the deferred work is a decoupled task rather than a frame nested inside the
 * lock holder. Revisit this comment if the Redis topology changes.
 *
 * The deferred callback is still wrapped in `guard`, because an exception
 * thrown inside a `setImmediate` callback is an unhandled rejection nobody can
 * catch otherwise.
 */
@Injectable()
export class VideoRoomSeatQueueListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomSeatQueueListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly queue: VideoRoomSeatQueueService,
    private readonly requests: VideoRoomSeatRequestService,
    private readonly rooms: VideoRoomsRepository,
    private readonly seats: VideoRoomSeatsRepository,
  ) {}

  onModuleInit(): void {
    // Deferred: the publisher (applyVacate) still holds videoRoomSeatLockKey.
    this.bus.subscribe<SeatLeftEvent>(VIDEO_ROOM_SEAT_EVENTS.LEFT, (e) => {
      setImmediate(() => {
        void this.guard('seat-left', () => this.onSeatFreed(e.payload.roomId, e.payload.seatIndex));
      });
    });
    // Deferred for the same reason — a reservation release can free a seat too.
    this.bus.subscribe<SeatReleasedEvent>(VIDEO_ROOM_SEAT_EVENTS.RELEASED, (e) => {
      setImmediate(() => {
        void this.guard('seat-released', () =>
          this.onSeatFreed(e.payload.roomId, e.payload.seatIndex),
        );
      });
    });
    // Synchronous — dequeue only, never calls seatUser/mutateStage. Also
    // resolves the Postgres row: a user seated via a route other than
    // approve/advance (takeSeat/transferSeat/switchSeat) still leaves a
    // PENDING request row behind, which `rebuild()` would otherwise replay
    // into the queue as a phantom entry after any Redis loss.
    this.bus.subscribe<SeatTakenEvent>(VIDEO_ROOM_SEAT_EVENTS.TAKEN, (e) =>
      this.guard('seat-taken', () => this.onSeatTaken(e.payload.roomId, e.payload.userId)),
    );
    // Same phantom-entry risk as above: a user who leaves the room keeps a
    // PENDING request row unless it's explicitly cancelled here.
    this.bus.subscribe<UserLeftEvent>(VIDEO_ROOM_EVENTS.USER_LEFT, (e) =>
      this.guard('user-left', () => this.onUserLeft(e.payload.roomId, e.payload.userId)),
    );
    this.bus.subscribe<UserReconnectedEvent>(VIDEO_ROOM_EVENTS.USER_RECONNECTED, (e) =>
      this.guard('user-reconnected', async () => {
        await this.requests.restore(e.payload.roomId, e.payload.userId);
      }),
    );
    this.bus.subscribe<RoomClosedEvent>(VIDEO_ROOM_EVENTS.CLOSED, (e) =>
      this.guard('room-closed', () => this.queue.clear(e.payload.roomId)),
    );
    this.bus.subscribe<RoomDeletedEvent>(VIDEO_ROOM_EVENTS.DELETED, (e) =>
      this.guard('room-deleted', () => this.queue.clear(e.payload.roomId)),
    );
  }

  /**
   * A seat became available. Auto-promote the front of the queue only when the
   * room has explicitly opted out of approval; otherwise just refresh
   * everyone's position so the UI reflects the newly open seat. Absent
   * settings (no row at all) are treated the same as approval-required, which
   * preserves existing rooms' behavior.
   */
  private async onSeatFreed(roomId: string, seatIndex: number): Promise<void> {
    if (seatIndex === VIDEO_ROOM_OWNER_SEAT_INDEX) return; // the owner seat is never queued for

    const settings = await this.rooms.getSettings(roomId);
    // Absent settings, or an explicit true, ⇒ approval required ⇒ no auto-seat.
    if (settings?.seatApprovalRequired !== false) {
      await this.queue.publishUpdate(roomId);
      return;
    }
    await this.queue.advance(roomId, seatIndex, VIDEO_ROOM_SYSTEM_ACTOR_ID);
  }

  /**
   * A user was seated (any route). Dequeue them AND resolve any PENDING
   * request row they hold in this room to PROMOTED, so `rebuild()` never
   * replays a now-seated user back into the queue.
   */
  private async onSeatTaken(roomId: string, userId: string): Promise<void> {
    await this.queue.dequeue(roomId, userId);
    await this.seats.resolveAllPendingRequestsForUser(
      roomId,
      userId,
      VideoRoomSeatRequestStatus.PROMOTED,
      VIDEO_ROOM_SYSTEM_ACTOR_ID,
    );
  }

  /**
   * A user left the room. Dequeue them AND cancel any PENDING request row
   * they hold in this room, so `rebuild()` never replays a departed user
   * back into the queue.
   */
  private async onUserLeft(roomId: string, userId: string): Promise<void> {
    await this.queue.dequeue(roomId, userId);
    await this.seats.resolveAllPendingRequestsForUser(
      roomId,
      userId,
      VideoRoomSeatRequestStatus.CANCELLED,
      VIDEO_ROOM_SYSTEM_ACTOR_ID,
    );
  }

  /** Run a handler, logging and swallowing any failure. */
  private async guard(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`Seat queue listener (${label}) failed: ${(err as Error).message}`);
    }
  }
}
