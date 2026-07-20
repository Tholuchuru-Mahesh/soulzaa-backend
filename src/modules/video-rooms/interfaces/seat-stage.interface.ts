import type { VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';

/**
 * The Redis-authoritative live seat snapshot (VR-4). The versioned snapshot is the
 * source of truth for reads + socket sync; `video_room_seats` is its durable
 * write-through projection. `SeatEntrySnapshot` mirrors the stored row plus the
 * `metadata`-derived `reason`/`premium` flags. Overlays (INVITED/REQUESTED) are NOT
 * stored here — they are composed at read time in the stage mapper.
 */
export interface SeatEntrySnapshot {
  seatIndex: number;
  seatType: VideoRoomSeatType; // OWNER | HOST | GUEST
  status: VideoRoomSeatStatus; // EMPTY | OCCUPIED | LOCKED | RESERVED
  occupantUserId: string | null;
  reservedForUserId: string | null;
  isLocked: boolean;
  isMuted: boolean;
  isVideoOn: boolean;
  reason: string | null; // 'disabled' | 'maintenance' | null (from metadata)
  premium: boolean; // metadata.premium === true
}

export interface SeatStageSnapshot {
  roomId: string;
  version: number;
  updatedAt: string; // ISO
  hostSeatCount: number;
  guestSeatCount: number;
  seats: SeatEntrySnapshot[];
}

/** The mutable subset a seat update may change (roomId/version/updatedAt are managed). */
export type SeatStageMutation = Partial<
  Pick<SeatStageSnapshot, 'seats' | 'hostSeatCount' | 'guestSeatCount'>
>;
