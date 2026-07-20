import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { VideoRoom, VideoRoomSeatStatus } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VIEWER_PRESENCE, type IViewerPresence } from '../interfaces/viewer-presence.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomEventService } from './video-room-event.service';
import { VideoRoomMediaService } from './video-room-media.service';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomSeatStateService } from './video-room-seat-state.service';
import { VideoRoomSeatService } from './video-room-seat.service';
import { VideoRoomSessionService } from './video-room-session.service';
import {
  VideoRoomMemberService,
  type JoinContext,
  type RoomSyncPayload,
} from './video-room-member.service';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * Viewer-mode facade (VR-6). A viewer IS a member with the default VIEWER role,
 * so lifecycle delegates verbatim to the VR-3 member/session services; this
 * class adds the viewer-scoped event vocabulary + payload shape on top, plus
 * host-driven promote/demote orchestration. Promote/demote are pure
 * orchestration over the existing seat/permission/media engines — no new
 * seat or permission logic lives here. Holds no Prisma/Redis of its own — the
 * audience count comes through the IViewerPresence seam, and seat occupancy
 * comes through the seat/seat-state services.
 */
@Injectable()
export class VideoRoomViewerService {
  private readonly logger = new Logger(VideoRoomViewerService.name);

  constructor(
    private readonly members: VideoRoomMemberService,
    private readonly sessions: VideoRoomSessionService,
    private readonly events: VideoRoomEventService,
    @Inject(VIEWER_PRESENCE) private readonly audience: IViewerPresence,
    private readonly metrics: VideoRoomsMetrics,
    private readonly repo: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly seat: VideoRoomSeatService,
    private readonly seatState: VideoRoomSeatStateService,
    private readonly media: VideoRoomMediaService,
  ) {}

  async joinAsViewer(
    actor: RoomActor,
    roomId: string,
    dto: { password?: string },
    ctx: JoinContext,
  ): Promise<RoomSyncPayload> {
    const payload = await this.members.join(actor, roomId, dto, ctx);
    const audienceCount = await this.audience.audienceCount(roomId);
    await this.events.emitViewerJoined({ roomId, userId: actor.id, viewerCount: audienceCount });
    this.metrics.setPeakViewers(audienceCount);
    return payload;
  }

  async leaveAsViewer(
    actor: RoomActor,
    roomId: string,
    dto: { socketId?: string },
    ctx?: { ip?: string },
  ): Promise<void> {
    await this.members.leave(actor, roomId, dto, ctx);
    const audienceCount = await this.audience.audienceCount(roomId);
    await this.events.emitViewerLeft({ roomId, userId: actor.id, viewerCount: audienceCount });
  }

  reconnectViewer(
    actor: RoomActor,
    roomId: string,
    dto: { previousSocketId?: string },
    ctx: JoinContext,
  ): Promise<RoomSyncPayload> {
    return this.members.reconnect(actor, roomId, dto, ctx);
  }

  async heartbeat(dto: { socketId: string; inBackground?: boolean }): Promise<{ alive: boolean }> {
    const alive = await this.sessions.heartbeat(dto.socketId, { inBackground: dto.inBackground });
    return { alive };
  }

  // ---- VR-6 promote / demote (host-driven, force-seat) ----

  /**
   * Force-seat a viewer onto the stage. Reuses the seat engine end to end
   * (`findOpenSeat`/`seatUser`) — no new occupancy logic here.
   */
  async promote(
    actor: RoomActor,
    roomId: string,
    dto: { targetUserId: string; seatIndex?: number },
    ip?: string,
  ): Promise<void> {
    const room = await this.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_SEATS);

    const member = await this.repo.getMember(roomId, dto.targetUserId);
    if (!member?.isActive) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_VIEWER,
        'That user is not a viewer in this room.',
        HttpStatus.CONFLICT,
      );
    }

    const seatIndex = dto.seatIndex ?? (await this.seat.findOpenSeat(actor, roomId));
    await this.seat.seatUser(roomId, dto.targetUserId, actor.id, seatIndex, ip);

    await this.repo.setParticipantStats(roomId, await this.occupiedSeatCount(roomId));
    await this.events.emitViewerPromoted({
      roomId,
      userId: dto.targetUserId,
      seatIndex,
      actorId: actor.id,
    });
    this.metrics.incViewerPromotion();
  }

  /**
   * Force a seated participant back to the audience. Reuses `vacateUser` +
   * `demoteToSubscriber` — no new seat/media logic here. Self-demote skips the
   * outranks check (you may always step down your own seat).
   */
  async demote(
    actor: RoomActor,
    roomId: string,
    dto: { targetUserId: string },
    ip?: string,
  ): Promise<void> {
    const room = await this.requireLiveRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.MANAGE_PARTICIPANTS);

    if ((await this.seatedSeatIndex(roomId, dto.targetUserId)) === null) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_PARTICIPANT,
        'That user is not a participant (holds no seat) in this room.',
        HttpStatus.CONFLICT,
      );
    }

    if (actor.id !== dto.targetUserId) {
      await this.permissions.assertOutranks(
        { id: room.id, ownerId: room.ownerId },
        actor.id,
        dto.targetUserId,
      );
    }

    await this.seat.vacateUser(roomId, dto.targetUserId, actor.id, 'seat.demoted', ip);
    try {
      await this.media.demoteToSubscriber(roomId, dto.targetUserId, actor.id);
    } catch (err) {
      this.logger.error(
        `Demote partial state: seat vacated but media downgrade failed for user ${dto.targetUserId} in room ${roomId}; both steps are idempotent — retry to reconcile.`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }

    await this.repo.setParticipantStats(roomId, await this.occupiedSeatCount(roomId));
    await this.events.emitViewerDemoted({ roomId, userId: dto.targetUserId, actorId: actor.id });
    this.metrics.incViewerDemotion();
  }

  /** Load the room and assert it is live (promotion/demotion need a live room). */
  private async requireLiveRoom(roomId: string): Promise<VideoRoom> {
    const room = await this.repo.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (room.status !== 'LIVE') {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_ENDED,
        'This room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    return room;
  }

  /** The seat index the user currently occupies, or null if they hold no seat. */
  private async seatedSeatIndex(roomId: string, userId: string): Promise<number | null> {
    const snap = await this.seatState.getSnapshot(roomId);
    if (!snap) return null;
    const seat = snap.seats.find(
      (s) => s.status === VideoRoomSeatStatus.OCCUPIED && s.occupantUserId === userId,
    );
    return seat ? seat.seatIndex : null;
  }

  /** The authoritative occupied-seat count from the live seat snapshot. */
  private async occupiedSeatCount(roomId: string): Promise<number> {
    const snap = await this.seatState.getSnapshot(roomId);
    if (!snap) return 0;
    return snap.seats.filter((s) => s.status === VideoRoomSeatStatus.OCCUPIED && s.occupantUserId)
      .length;
  }
}
