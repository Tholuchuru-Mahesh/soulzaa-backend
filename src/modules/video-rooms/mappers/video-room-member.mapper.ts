import type { VideoRoomMember } from '@prisma/client';
import type { VideoRoomMemberView, VideoRoomSessionView } from '../entities/video-room-member.view';
import type { VideoRoomSessionRecord } from '../interfaces/room-session-manager.interface';

/** Project a durable member row to its client-safe view (drops audit + join context). */
export function toVideoRoomMemberView(m: VideoRoomMember): VideoRoomMemberView {
  return {
    userId: m.userId,
    role: m.role,
    memberStatus: m.memberStatus,
    joinedAt: m.joinedAt,
    lastActiveAt: m.lastActiveAt,
    isActive: m.isActive,
  };
}

/** Project a live session record to the caller's own session view (drops audit fields). */
export function toVideoRoomSessionView(r: VideoRoomSessionRecord): VideoRoomSessionView {
  return {
    roomId: r.roomId,
    userId: r.userId,
    socketId: r.socketId,
    presenceState: r.presenceState,
    connectedAt: r.connectedAt,
    lastSeenAt: r.lastSeenAt,
    reconnectCount: r.reconnectCount,
  };
}
