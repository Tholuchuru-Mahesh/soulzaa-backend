import type { VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';
import type { DisplayStatus } from '../constants/video-room-seat-lifecycle';

/**
 * Client-safe projection of the live seat stage (VR-4). Adds the computed
 * `displayStatus` (the full 8-state surface) and the read-time overlays
 * (`invitedUserId`, `requestedBy`) on top of the stored seat entry. Audit/internal
 * columns never appear here.
 */
export interface SeatEntryView {
  seatIndex: number;
  seatType: VideoRoomSeatType;
  status: VideoRoomSeatStatus;
  displayStatus: DisplayStatus;
  occupantUserId: string | null;
  reservedForUserId: string | null;
  invitedUserId: string | null;
  requestedBy: string[];
  isLocked: boolean;
  isMuted: boolean;
  isVideoOn: boolean;
  premium: boolean;
}

export interface SeatStageView {
  roomId: string;
  version: number;
  hostSeatCount: number;
  guestSeatCount: number;
  seats: SeatEntryView[];
}
