import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { VideoRoomSeatRequest, VideoRoomSeatRequestStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { VIDEO_ROOM_SEAT_REQUEST_TTL_SECONDS } from '../constants/video-room.constants';
import type { VideoRoomSeatRequestView } from '../entities/video-room-stage.view';
import { SeatRequestResolvedEvent, SeatRequestedEvent } from '../events/video-room-seat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { toVideoRoomSeatRequestView } from '../mappers/video-room-stage.mapper';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomSeatService } from './video-room-seat.service';

/** Context for ranking pending requests at read time. */
export interface RequestPriorityContext {
  rank: Map<string, number>; // userId → in-room authority rank
  vip: Map<string, number>; // userId → VIP level (0 if none)
}

/**
 * LEARNING CONTRIBUTION POINT — how pending seat requests are ordered.
 *
 * Requests are NOT a durable queue; they are ranked at read time so policy is a code
 * change, not a data migration. Return <0 if `a` should be offered a seat before `b`.
 * The shipped default is pure FIFO (earliest request first). A richer policy (spec §9)
 * might be: higher authority rank first, then higher VIP level, then FIFO — e.g.
 *
 *   const byRank = (ctx.rank.get(b.userId) ?? 0) - (ctx.rank.get(a.userId) ?? 0);
 *   if (byRank !== 0) return byRank;
 *   const byVip = (ctx.vip.get(b.userId) ?? 0) - (ctx.vip.get(a.userId) ?? 0);
 *   if (byVip !== 0) return byVip;
 *   return a.createdAt.getTime() - b.createdAt.getTime();
 *
 * Fill in the precedence your product wants; keep the return-value contract above.
 */
export function compareRequestPriority(
  a: VideoRoomSeatRequest,
  b: VideoRoomSeatRequest,
  _ctx: RequestPriorityContext,
): number {
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * Seat request workflow (VR-4): a viewer/participant asks for a seat; owner/admin
 * approve or reject. Multiple pending requests are supported; ordering is computed at
 * read time via `compareRequestPriority` (no queue table). Approval seats the
 * requester through `VideoRoomSeatService.seatUser` (the shared locked pipeline).
 */
@Injectable()
export class VideoRoomSeatRequestService {
  constructor(
    private readonly seatSvc: VideoRoomSeatService,
    private readonly seats: VideoRoomSeatsRepository,
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly events: VideoRoomEventsRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  /** Ask for a seat (a specific seat, or any). One pending request per user. */
  async request(
    actor: RoomActor,
    roomId: string,
    seatIndex?: number,
    ip?: string,
  ): Promise<VideoRoomSeatRequestView> {
    await this.seatSvc.requireLiveRoom(roomId);
    const member = await this.rooms.getMember(roomId, actor.id);
    if (!member?.isActive) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'You must join the room first.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (await this.seats.findPendingRequest(roomId, actor.id)) {
      throw new BusinessException(
        ERROR_CODES.DUPLICATE_SEAT_REQUEST,
        'You already have a pending seat request.',
        HttpStatus.CONFLICT,
      );
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
    await this.seats.setRequestStatus(
      existing.id,
      VideoRoomSeatRequestStatus.CANCELLED,
      actor.id,
      actor.id,
    );
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

  /** Approve a request (owner/admin): seat the requester on the requested / next-free seat. */
  async approve(actor: RoomActor, roomId: string, requestId: string, ip?: string) {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    const req = await this.requirePendingRequest(roomId, requestId);
    const seatIndex = req.seatIndex ?? (await this.seatSvc.findOpenSeat(actor, roomId));
    const view = await this.seatSvc.seatUser(roomId, req.userId, actor.id, seatIndex, ip);
    await this.seats.setRequestStatus(
      req.id,
      VideoRoomSeatRequestStatus.ACCEPTED,
      actor.id,
      actor.id,
    );
    await this.bus.publish(
      new SeatRequestResolvedEvent({
        roomId,
        requestId: req.id,
        userId: req.userId,
        status: 'ACCEPTED',
        actorId: actor.id,
        version: view.version,
        seatIndex,
      }),
    );
    return view;
  }

  /** Reject a request (owner/admin). */
  async reject(actor: RoomActor, roomId: string, requestId: string, ip?: string): Promise<void> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    const req = await this.requirePendingRequest(roomId, requestId);
    await this.seats.setRequestStatus(
      req.id,
      VideoRoomSeatRequestStatus.REJECTED,
      actor.id,
      actor.id,
    );
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
      }),
    );
  }

  /** Pending requests, ordered by read-time priority (see `compareRequestPriority`). */
  async listRequests(actor: RoomActor, roomId: string): Promise<VideoRoomSeatRequestView[]> {
    const room = await this.seatSvc.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);
    const pending = await this.seats.listPendingRequests(roomId);
    const rank = new Map<string, number>();
    for (const req of pending) {
      rank.set(req.userId, await this.permissions.authorityRank(room, req.userId));
    }
    const ctx: RequestPriorityContext = { rank, vip: new Map() };
    return [...pending]
      .sort((a, b) => compareRequestPriority(a, b, ctx))
      .map(toVideoRoomSeatRequestView);
  }

  // ---- Internal ----

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
