import type { VideoRoomMemberRole, VideoRoomMemberStatus } from '@prisma/client';
import type { VideoRoomPresenceState } from '../enums';

/** Client-safe projection of a room member (drops deviceId/audit/internal cols). */
export interface VideoRoomMemberView {
  userId: string;
  role: VideoRoomMemberRole;
  memberStatus: VideoRoomMemberStatus;
  joinedAt: Date;
  lastActiveAt: Date;
  isActive: boolean;
}

/** Client-safe live presence for one member (VR-3). */
export interface VideoRoomPresenceView {
  userId: string;
  state: VideoRoomPresenceState;
  socketId: string | null;
  lastSeenAt: string | null;
}

/** The caller's own session view (GET /session) — drops ip/sid/deviceId (audit-only). */
export interface VideoRoomSessionView {
  roomId: string;
  userId: string;
  socketId: string;
  presenceState: VideoRoomPresenceState;
  connectedAt: string;
  lastSeenAt: string;
  reconnectCount: number;
}
