import type {
  VideoRoomInvitation,
  VideoRoomRole,
  VideoRoomSeat,
  VideoRoomSeatRequest,
} from '@prisma/client';
import type {
  VideoRoomInvitationView,
  VideoRoomRoleView,
  VideoRoomSeatRequestView,
  VideoRoomSeatView,
} from '../entities/video-room-stage.view';

/** Row → client-safe seat view (drops audit/metadata). */
export function toVideoRoomSeatView(seat: VideoRoomSeat): VideoRoomSeatView {
  return {
    seatIndex: seat.seatIndex,
    seatType: seat.seatType,
    seatStatus: seat.seatStatus,
    occupantUserId: seat.occupantUserId,
    reservedForUserId: seat.reservedForUserId,
    isLocked: seat.isLocked,
    isMuted: seat.isMuted,
    isVideoOn: seat.isVideoOn,
  };
}

export function toVideoRoomSeatRequestView(req: VideoRoomSeatRequest): VideoRoomSeatRequestView {
  return {
    id: req.id,
    userId: req.userId,
    seatIndex: req.seatIndex,
    status: req.status,
    createdAt: req.createdAt,
  };
}

export function toVideoRoomInvitationView(inv: VideoRoomInvitation): VideoRoomInvitationView {
  return {
    id: inv.id,
    inviterId: inv.inviterId,
    inviteeUserId: inv.inviteeUserId,
    type: inv.type,
    seatIndex: inv.seatIndex,
    status: inv.status,
    expiresAt: inv.expiresAt,
  };
}

export function toVideoRoomRoleView(role: VideoRoomRole): VideoRoomRoleView {
  return {
    userId: role.userId,
    role: role.role,
    grantedBy: role.grantedBy,
    expiresAt: role.expiresAt,
  };
}
