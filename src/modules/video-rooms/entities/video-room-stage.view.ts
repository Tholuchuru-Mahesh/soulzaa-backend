import type {
  VideoRoomInvitationStatus,
  VideoRoomInvitationType,
  VideoRoomMemberRole,
  VideoRoomSeatRequestStatus,
  VideoRoomSeatStatus,
  VideoRoomSeatType,
} from '@prisma/client';

/**
 * Client-safe projections of the multi-seat stage entities. Internal audit
 * columns are dropped by the mappers so a new sensitive column cannot leak into a
 * response by being spread. Defined in VR-1 so the API shapes are stable before
 * the seat phase implements the endpoints.
 */

export interface VideoRoomSeatView {
  seatIndex: number;
  seatType: VideoRoomSeatType;
  seatStatus: VideoRoomSeatStatus;
  occupantUserId: string | null;
  reservedForUserId: string | null;
  isLocked: boolean;
  isMuted: boolean;
  isVideoOn: boolean;
}

export interface VideoRoomSeatRequestView {
  id: string;
  userId: string;
  seatIndex: number | null;
  status: VideoRoomSeatRequestStatus;
  createdAt: Date;
}

export interface VideoRoomInvitationView {
  id: string;
  inviterId: string;
  inviteeUserId: string;
  type: VideoRoomInvitationType;
  seatIndex: number | null;
  status: VideoRoomInvitationStatus;
  expiresAt: Date;
}

export interface VideoRoomRoleView {
  userId: string;
  role: VideoRoomMemberRole;
  grantedBy: string | null;
  expiresAt: Date | null;
}
