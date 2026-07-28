import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  VideoRoomSeatRequest,
  VideoRoomSeatRequestStatus,
  VideoRoomSeatStatus,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { PublicIdentity } from 'src/modules/users/interfaces/profile.interface';
import { canTransitionRequest } from '../constants/video-room-seat-workflow';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  VIDEO_ROOM_SEAT_REQUEST_MAX_ATTEMPTS,
  VIDEO_ROOM_SEAT_REQUEST_RESTORE_GRACE_SECONDS,
  VIDEO_ROOM_SEAT_REQUEST_TTL_SECONDS,
} from '../constants/video-room.constants';
import type { SeatStageView } from '../entities/video-room-seat-stage.view';
import type { VideoRoomSeatRequestView } from '../entities/video-room-stage.view';
import { SeatRequestResolvedEvent, SeatRequestedEvent } from '../events/video-room-seat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { toVideoRoomSeatRequestView } from '../mappers/video-room-stage.mapper';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import type { SetRequestStatusOptions } from '../repositories/video-room-seats.repository';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomIdentityCache } from './video-room-identity-cache.service';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomSeatQueueService } from './video-room-seat-queue.service';
import { VideoRoomSeatService } from './video-room-seat.service';

/**
 * Seat request workflow (VR-4/VR-8): a viewer/participant asks for a seat;
 * owner/admin approve or reject. Pending requests are FIFO-ordered by a Redis
 * queue projection (`VideoRoomSeatQueueService`) rather than ranked at read
 * time — `listRequests` simply asks the queue for each row's position.
 * Approval seats the requester through `VideoRoomSeatService.seatUser` (the
 * shared locked pipeline); a failed seating marks the request FAILED and
 * dequeues it (Fix I4 — a FAILED row has no "still pending" Postgres state,
 * so leaving it queued is a lie the projection can't back up), and `retry`
 * re-enqueues it at its original position, bounded by `attemptCount`.
 */
@Injectable()
export class VideoRoomSeatRequestService {
  private readonly logger = new Logger(VideoRoomSeatRequestService.name);

  constructor(
    private readonly seatSvc: VideoRoomSeatService,
    private readonly seats: VideoRoomSeatsRepository,
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly events: VideoRoomEventsRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly queue: VideoRoomSeatQueueService,
    private readonly identities: VideoRoomIdentityCache,
  ) {}

  /** Ask for a seat (a specific seat, or any). One pending request per user. */
  async request(
    actor: RoomActor,
    roomId: string,
    seatIndex?: number,
    ip?: string,
  ): Promise<VideoRoomSeatRequestView> {
    await this.assertEligibleToQueue(roomId, actor.id);

    if (await this.seats.findPendingRequest(roomId, actor.id)) {
      throw new BusinessException(
        ERROR_CODES.DUPLICATE_SEAT_REQUEST,
        'You already have a pending seat request.',
        HttpStatus.CONFLICT,
      );
    }

    // VR-8 — when a specific seat is named, it must exist and be takeable.
    if (seatIndex !== undefined) {
      const seat = await this.seats.findSeat(roomId, seatIndex);
      if (!seat) {
        throw new BusinessException(
          ERROR_CODES.SEAT_NOT_FOUND,
          'That seat does not exist in this room.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (seat.isLocked) {
        throw new BusinessException(
          ERROR_CODES.SEAT_LOCKED,
          'That seat is locked.',
          HttpStatus.CONFLICT,
        );
      }
      if (seat.seatStatus === VideoRoomSeatStatus.RESERVED) {
        throw new BusinessException(
          ERROR_CODES.SEAT_RESERVED,
          'That seat is reserved.',
          HttpStatus.CONFLICT,
        );
      }
    }

    const expiresAt = new Date(Date.now() + VIDEO_ROOM_SEAT_REQUEST_TTL_SECONDS * 1000);
    const req = await this.seats.createRequest(
      { roomId, userId: actor.id, seatIndex: seatIndex ?? null, expiresAt },
      actor.id,
    );
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.requested',
      payload: { requestId: req.id, seatIndex: seatIndex ?? null, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatRequestedEvent({
        roomId,
        requestId: req.id,
        userId: actor.id,
        seatIndex: seatIndex ?? null,
      }),
    );
    await this.queue.enqueue(roomId, actor.id, req.createdAt);
    return toVideoRoomSeatRequestView(req);
  }

  /** Cancel your own pending request. */
  async cancelRequest(actor: RoomActor, roomId: string, ip?: string): Promise<void> {
    const existing = await this.seats.findPendingRequest(roomId, actor.id);
    if (!existing) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_NOT_FOUND,
        'You have no pending seat request.',
        HttpStatus.NOT_FOUND,
      );
    }
    // I6 — CAS'd on the PENDING this just read: an admin approving the exact
    // instant the requester cancels must not have their PROMOTED silently
    // overwritten by this CANCELLED (or vice versa) — whichever write lands
    // first wins the row, and the other gets a clean CONFLICT.
    await this.transitionRequest(
      existing,
      VideoRoomSeatRequestStatus.CANCELLED,
      actor.id,
      actor.id,
    );
    await this.queue.dequeue(roomId, actor.id);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.request_cancelled',
      payload: { requestId: existing.id, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatRequestResolvedEvent({
        roomId,
        requestId: existing.id,
        userId: actor.id,
        status: 'CANCELLED',
        actorId: actor.id,
      }),
    );
  }

  /** Change the preferred seat on your own still-pending request. */
  async updateRequest(
    actor: RoomActor,
    roomId: string,
    seatIndex: number | null,
    ip?: string,
  ): Promise<VideoRoomSeatRequestView> {
    await this.seatSvc.requireLiveRoom(roomId);
    const existing = await this.seats.findPendingRequest(roomId, actor.id);
    if (!existing) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_NOT_FOUND,
        'You have no pending seat request.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (seatIndex !== null) {
      const seat = await this.seats.findSeat(roomId, seatIndex);
      if (!seat) {
        throw new BusinessException(
          ERROR_CODES.SEAT_NOT_FOUND,
          'That seat does not exist in this room.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (seat.isLocked) {
        throw new BusinessException(
          ERROR_CODES.SEAT_LOCKED,
          'That seat is locked.',
          HttpStatus.CONFLICT,
        );
      }
    }
    const updated = await this.seats.updateRequestSeatIndex(existing.id, seatIndex, actor.id);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.request_updated',
      payload: { requestId: existing.id, seatIndex, ...(ip ? { ip } : {}) },
    });
    await this.queue.publishUpdate(roomId);
    return toVideoRoomSeatRequestView(updated);
  }

  /** Approve a request (owner/admin): seat the requester on the requested / next-free seat. */
  async approve(
    actor: RoomActor,
    roomId: string,
    requestId: string,
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    const req = await this.requirePendingRequest(roomId, requestId);
    return this.driveSeating(actor, roomId, req, ip);
  }

  /**
   * Re-drive a FAILED request's seating. Bounded by `attemptCount` so a
   * request that fails for a structural reason cannot be retried forever.
   * Operates on the already-fetched row (rather than re-reading it through
   * `approve`'s `requirePendingRequest`, which demands PENDING) since the
   * status was only just flipped to PENDING by the write below.
   */
  async retry(
    actor: RoomActor,
    roomId: string,
    requestId: string,
    ip?: string,
  ): Promise<SeatStageView> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);

    const req = await this.seats.findRequestById(requestId);
    if (!req || req.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_NOT_FOUND,
        'Seat request not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    // I6 — deliberately NARROWER than SEAT_REQUEST_TRANSITIONS, which also
    // allows EXPIRED → PENDING: that path belongs to `restore()` alone, with
    // its own grace-window + re-eligibility checks. Admitting EXPIRED here
    // too would let a stale, TTL-lapsed request skip straight back into
    // seating via the attempt-bounded retry path instead of restore's
    // queue-jump-exploit guard. Keep this exact check narrow; do not widen it
    // to `!canTransitionRequest(req.status, PENDING)`.
    if (req.status !== VideoRoomSeatRequestStatus.FAILED) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_INVALID_TRANSITION,
        `A request in state ${req.status} cannot be retried.`,
        HttpStatus.CONFLICT,
      );
    }
    if (req.attemptCount >= VIDEO_ROOM_SEAT_REQUEST_MAX_ATTEMPTS) {
      throw new BusinessException(
        ERROR_CODES.SEAT_RETRY_EXHAUSTED,
        `This request has already used all ${VIDEO_ROOM_SEAT_REQUEST_MAX_ATTEMPTS} seating attempts.`,
        HttpStatus.CONFLICT,
      );
    }
    // VR-8 — a FAILED request is stale within VIDEO_ROOM_SEAT_REQUEST_TTL_SECONDS
    // (60s); re-driving seating on one an operator retried later would seat a
    // requester who has almost certainly moved on.
    if (req.expiresAt && req.expiresAt.getTime() < Date.now()) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_EXPIRED,
        'Seat request has expired.',
        HttpStatus.CONFLICT,
      );
    }

    // I6 — CAS'd on the FAILED this just read: two concurrent retries of the
    // same request must not both proceed into `driveSeating` (the loser gets
    // a clean CONFLICT here instead of racing the winner all the way to a
    // second, clobbering `seatUser` attempt).
    await this.transitionRequest(req, VideoRoomSeatRequestStatus.PENDING, actor.id, actor.id, {
      lastError: null,
    });
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.request_retried',
      payload: { requestId: req.id, attempt: req.attemptCount + 1, ...(ip ? { ip } : {}) },
    });
    // Fix I4 — a FAILED request was dequeued (see `driveSeating`'s failure
    // branch below); re-enqueue at the request's ORIGINAL createdAt, exactly
    // as `restore()` does, so a retried user resumes their former queue
    // position instead of joining at the back.
    await this.queue.enqueue(roomId, req.userId, req.createdAt);
    // `req` is stale (still reads FAILED in memory) — the write above just
    // moved the row to PENDING, which is what `driveSeating`'s own CAS needs
    // to see as the "from" state.
    const pendingReq: VideoRoomSeatRequest = {
      ...req,
      status: VideoRoomSeatRequestStatus.PENDING,
    };
    return this.driveSeating(actor, roomId, pendingReq, ip);
  }

  /**
   * Reconnect recovery: revive a request that expired while the user was
   * disconnected. `createdAt` is untouched, so re-enqueueing yields the same
   * ZSET score and the viewer resumes at exactly their old position. Returns
   * null when there is nothing eligible — a deliberate cancel (or a FAILED
   * request, which belongs to `retry` instead) is never resurrected.
   *
   * Fix I8 — two guards bound this, and neither throws: `restore` is called
   * from the `UserReconnectedEvent` listener, which must not fail the
   * reconnect itself, so any disqualification (stale row or a failed re-entry
   * check) simply yields null instead of a rejection.
   *
   *  1. **Grace window.** The row must have been resolved (i.e. expired) no
   *     longer ago than `VIDEO_ROOM_SEAT_REQUEST_RESTORE_GRACE_SECONDS`.
   *     Without this, `restore` at its original `createdAt` would always land
   *     the requester in the lowest-scoring (highest-priority) VIP band —
   *     the exploit was: request, let it expire, wait arbitrarily long, then
   *     reconnect to jump the queue.
   *  2. **Re-entry validation.** The same room-live / active-member / not
   *     blocked / not-already-seated checks `request()` applies, via the
   *     shared `assertEligibleToQueue` — a user blocked or seated since their
   *     request expired must not have it revived.
   *
   * I6 — the `latest.status !== EXPIRED` check is deliberately NARROWER than
   * `SEAT_REQUEST_TRANSITIONS`, which also allows FAILED → PENDING: that path
   * is `retry()`'s alone (attempt-bounded, no grace window). Do not widen
   * this to accept FAILED rows too — it would let a failed seating attempt
   * skip retry's attempt-count ceiling entirely.
   */
  async restore(
    roomId: string,
    userId: string,
    ip?: string,
  ): Promise<VideoRoomSeatRequestView | null> {
    const latest = await this.seats.findLatestRequestForUser(roomId, userId);
    if (!latest || latest.status !== VideoRoomSeatRequestStatus.EXPIRED) return null;

    const resolvedAgoMs = latest.resolvedAt ? Date.now() - latest.resolvedAt.getTime() : Infinity;
    if (resolvedAgoMs > VIDEO_ROOM_SEAT_REQUEST_RESTORE_GRACE_SECONDS * 1000) return null;

    try {
      await this.assertEligibleToQueue(roomId, userId);
    } catch (err) {
      if (err instanceof BusinessException) return null;
      throw err;
    }

    const expiresAt = new Date(Date.now() + VIDEO_ROOM_SEAT_REQUEST_TTL_SECONDS * 1000);
    const restored = await this.seats.restoreRequest(latest.id, userId, expiresAt);
    await this.events.appendEvent({
      roomId,
      actorId: userId,
      eventType: 'seat.request_restored',
      payload: { requestId: latest.id, ...(ip ? { ip } : {}) },
    });
    // Original createdAt → identical score → identical queue position.
    await this.queue.enqueue(roomId, userId, latest.createdAt);
    return toVideoRoomSeatRequestView(restored);
  }

  /** Reject a request (owner/admin). */
  async reject(actor: RoomActor, roomId: string, requestId: string, ip?: string): Promise<void> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    const req = await this.requirePendingRequest(roomId, requestId);
    // I6 — CAS'd on the PENDING this just read: see `cancelRequest` for why
    // (approve/cancel/reject all read PENDING independently and must not
    // clobber whichever of them writes first).
    await this.transitionRequest(req, VideoRoomSeatRequestStatus.REJECTED, actor.id, actor.id);
    await this.queue.dequeue(roomId, req.userId);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.request_rejected',
      payload: { requestId: req.id, userId: req.userId, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatRequestResolvedEvent({
        roomId,
        requestId: req.id,
        userId: req.userId,
        status: 'REJECTED',
        actorId: actor.id,
        requestedAt: req.createdAt.toISOString(),
      }),
    );
  }

  /** Pending requests in queue order, each carrying its 1-based position. */
  async listRequests(
    actor: RoomActor,
    roomId: string,
  ): Promise<Array<VideoRoomSeatRequestView & { position: number | null; user?: PublicIdentity }>> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    const pending = await this.seats.listPendingRequests(roomId);

    // Identity is display-only: a lookup failure must degrade to bare rows
    // rather than 500 the host's Requests panel.
    let identities = new Map<string, PublicIdentity>();
    try {
      identities = await this.identities.resolve(pending.map((r) => r.userId));
    } catch (err) {
      this.logger.warn(`Identity enrichment failed for room ${roomId}: ${String(err)}`);
    }

    const rows = await Promise.all(
      pending.map(async (req) => ({
        ...toVideoRoomSeatRequestView(req),
        position: await this.queue.position(roomId, req.userId),
        user: identities.get(req.userId),
      })),
    );
    return rows.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  }

  // ---- Internal ----

  /**
   * The entry gate shared by `request()` (a fresh ask) and `restore()` (a
   * reconnect reviving an EXPIRED one): the room must be live, the caller
   * must be an active member, not blocked, and not already seated. Extracted
   * (Fix I8) so both call sites enforce the identical rule set rather than
   * `restore()` bypassing checks `request()` requires.
   */
  private async assertEligibleToQueue(roomId: string, userId: string): Promise<void> {
    await this.seatSvc.requireLiveRoom(roomId);
    const member = await this.rooms.getMember(roomId, userId);
    if (!member?.isActive) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'You must join the room first.',
        HttpStatus.FORBIDDEN,
      );
    }

    // VR-8 — room-level ban/block.
    if (await this.moderation.isActivelyBlocked(roomId, userId)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_BLOCKED,
        'You are blocked from this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    // VR-8 — already a participant: nothing to request/restore.
    if (await this.seats.findOccupiedSeat(roomId, userId)) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_ON_SEAT,
        'You already hold a seat in this room.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Attempt-seat / resolve-outcome, shared by `approve` and `retry`: mark
   * ACCEPTED, try `seatUser`, then split into PROMOTED (dequeue + event) or
   * FAILED (dequeue + event; `retry` re-enqueues at the original createdAt
   * when it flips the row back to PENDING) + rethrow.
   *
   * I6 — the ACCEPTED write below is CAS'd on the PENDING `req.status` its
   * two callers each independently read (approve via `requirePendingRequest`,
   * retry via its own freshly-flipped row). That single compare-and-swap is
   * the fix for the concrete double-approve race: two admins approving the
   * same request concurrently both used to pass their read, both write
   * ACCEPTED, and whichever `seatUser` lost wrote FAILED over the winner's
   * PROMOTED. Now only one CAS can succeed; the loser gets a CONFLICT here
   * and never calls `seatUser` at all. The PROMOTED/FAILED writes further
   * down stay unconditional — by the time we reach them, this CAS has
   * already proven exclusive ownership of the row, so there is no longer a
   * write to race against.
   */
  private async driveSeating(
    actor: RoomActor,
    roomId: string,
    req: VideoRoomSeatRequest,
    ip?: string,
  ): Promise<SeatStageView> {
    const seatIndex = req.seatIndex ?? (await this.seatSvc.findOpenSeat(actor, roomId));
    await this.transitionRequest(req, VideoRoomSeatRequestStatus.ACCEPTED, actor.id, actor.id);

    let view: SeatStageView;
    try {
      view = await this.seatSvc.seatUser(roomId, req.userId, actor.id, seatIndex, ip);
    } catch (err) {
      // A transient infra error (lock-acquisition failure, Redis/Postgres blip)
      // must not burn the request's attempt budget — only a genuine business
      // rejection (seat taken/locked/etc.) counts as a failed attempt.
      if (!(err instanceof BusinessException)) throw err;
      const message = (err as Error).message;
      // Unconditional — exclusivity on this row was already established by
      // the ACCEPTED CAS above; no concurrent actor can also be here.
      await this.seats.setRequestStatus(
        req.id,
        VideoRoomSeatRequestStatus.FAILED,
        actor.id,
        actor.id,
        { bumpAttempt: true, lastError: message },
      );
      // Fix I4 — a FAILED row has no Postgres-side "still pending" status, so
      // leaving it in the Redis queue is a lie the projection can't back up:
      // `rebuild()` (PENDING-only) would drop it on any Redis loss, and the
      // very next `advance()` pass would find no matching PENDING request and
      // silently `sortedRemove` it anyway. Dequeuing here is the honest
      // reflection of that; `retry()` re-enqueues at the ORIGINAL createdAt
      // when it flips the row back to PENDING, so the requester resumes their
      // former position rather than losing their place.
      await this.queue.dequeue(roomId, req.userId);
      await this.events.appendEvent({
        roomId,
        actorId: actor.id,
        eventType: 'seat.request_failed',
        payload: { requestId: req.id, userId: req.userId, reason: message, ...(ip ? { ip } : {}) },
      });
      await this.bus.publish(
        new SeatRequestResolvedEvent({
          roomId,
          requestId: req.id,
          userId: req.userId,
          status: 'FAILED',
          actorId: actor.id,
          requestedAt: req.createdAt.toISOString(),
        }),
      );
      throw err;
    }

    // Unconditional — same reasoning as the FAILED branch above.
    await this.seats.setRequestStatus(
      req.id,
      VideoRoomSeatRequestStatus.PROMOTED,
      actor.id,
      actor.id,
      { bumpAttempt: true, lastError: null },
    );
    await this.queue.dequeue(roomId, req.userId);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'seat.request_promoted',
      payload: { requestId: req.id, userId: req.userId, seatIndex, ...(ip ? { ip } : {}) },
    });
    await this.bus.publish(
      new SeatRequestResolvedEvent({
        roomId,
        requestId: req.id,
        userId: req.userId,
        status: 'PROMOTED',
        actorId: actor.id,
        version: view.version,
        seatIndex,
        requestedAt: req.createdAt.toISOString(),
      }),
    );
    return view;
  }

  /**
   * I6 — the guard-table + compare-and-swap chokepoint for every write that
   * begins a decision from a status this caller *just read* (as opposed to
   * the PROMOTED/FAILED writes in `driveSeating`, which follow a write this
   * same call already made exclusive). Two steps:
   *
   *  1. Validate `req.status → to` against `SEAT_REQUEST_TRANSITIONS` — an
   *     illegal transition raises `SEAT_REQUEST_INVALID_TRANSITION` before a
   *     write is even attempted.
   *  2. Write conditionally on the row still being in `req.status`. If
   *     another actor already moved it (the concrete race this fixes — e.g.
   *     two admins approving/rejecting/cancelling the same PENDING request
   *     concurrently), the repository reports the loss (`null`) and this
   *     raises the same CONFLICT rather than silently overwriting whatever
   *     that actor wrote.
   */
  private async transitionRequest(
    req: VideoRoomSeatRequest,
    to: VideoRoomSeatRequestStatus,
    actorId: string,
    resolvedBy: string | null,
    opts?: Omit<SetRequestStatusOptions, 'expectedFrom'>,
  ): Promise<void> {
    if (!canTransitionRequest(req.status, to)) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_INVALID_TRANSITION,
        `A request in state ${req.status} cannot move to ${to}.`,
        HttpStatus.CONFLICT,
      );
    }
    const updated = await this.seats.setRequestStatus(req.id, to, actorId, resolvedBy, {
      ...opts,
      expectedFrom: req.status,
    });
    if (!updated) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_INVALID_TRANSITION,
        `Seat request ${req.id} is no longer ${req.status}; another actor already resolved it.`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private async requirePendingRequest(
    roomId: string,
    requestId: string,
  ): Promise<VideoRoomSeatRequest> {
    const req = await this.seats.findRequestById(requestId);
    if (!req || req.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_NOT_FOUND,
        'Seat request not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (req.status !== VideoRoomSeatRequestStatus.PENDING) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_NOT_FOUND,
        'Seat request is no longer pending.',
        HttpStatus.CONFLICT,
      );
    }
    if (req.expiresAt && req.expiresAt.getTime() < Date.now()) {
      throw new BusinessException(
        ERROR_CODES.SEAT_REQUEST_EXPIRED,
        'Seat request has expired.',
        HttpStatus.CONFLICT,
      );
    }
    return req;
  }
}
