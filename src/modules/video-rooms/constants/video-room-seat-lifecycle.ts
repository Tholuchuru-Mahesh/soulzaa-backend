import { VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';
import { VIDEO_ROOM_OWNER_SEAT_INDEX } from './video-room.constants';

/**
 * The seat state machine + client-facing display-status derivation (VR-4).
 *
 * Only four statuses are *stored* (`VideoRoomSeatStatus`: EMPTY/OCCUPIED/LOCKED/
 * RESERVED). The brief's richer surface — INVITED, REQUESTED, DISABLED, MAINTENANCE —
 * is *derived* here from adjacent state (a pending invite/request row, or a
 * `metadata.reason`), so no schema change is needed. This is the CQRS read-model:
 * the stored status stays small + normalised; the client sees the full 8-state view.
 */

export type DisplayStatus =
  | 'EMPTY'
  | 'OCCUPIED'
  | 'LOCKED'
  | 'RESERVED'
  | 'INVITED'
  | 'REQUESTED'
  | 'DISABLED'
  | 'MAINTENANCE';

/**
 * LEARNING CONTRIBUTION POINT — the seat state-machine legality table.
 *
 * Each key is a *from* status; its set lists the *to* statuses allowed. This is a
 * product decision: e.g. may a LOCKED seat go straight to RESERVED, or must it
 * pass through EMPTY (unlock) first? The default below matches design spec §7
 * (LOCKED only unlocks to EMPTY). Adjust the sets if your product differs — keep
 * the map total (every enum value keyed) so `canSeatTransition` never reads
 * `undefined`.
 */
export const SEAT_TRANSITIONS: Record<VideoRoomSeatStatus, ReadonlySet<VideoRoomSeatStatus>> = {
  [VideoRoomSeatStatus.EMPTY]: new Set([
    VideoRoomSeatStatus.OCCUPIED,
    VideoRoomSeatStatus.RESERVED,
    VideoRoomSeatStatus.LOCKED,
  ]),
  [VideoRoomSeatStatus.RESERVED]: new Set([
    VideoRoomSeatStatus.OCCUPIED,
    VideoRoomSeatStatus.EMPTY,
    VideoRoomSeatStatus.LOCKED,
  ]),
  [VideoRoomSeatStatus.OCCUPIED]: new Set([
    VideoRoomSeatStatus.EMPTY,
    VideoRoomSeatStatus.OCCUPIED, // occupant changes (switch / transfer)
    VideoRoomSeatStatus.LOCKED, // lock while occupied forces a vacate
  ]),
  [VideoRoomSeatStatus.LOCKED]: new Set([VideoRoomSeatStatus.EMPTY]),
};

/** True if the seat may move from `from` to `to` under the state machine. */
export function canSeatTransition(from: VideoRoomSeatStatus, to: VideoRoomSeatStatus): boolean {
  return SEAT_TRANSITIONS[from]?.has(to) ?? false;
}

/** Seat index 0 is always the protected owner seat. */
export function isOwnerSeat(seatIndex: number): boolean {
  return seatIndex === VIDEO_ROOM_OWNER_SEAT_INDEX;
}

/** One seat in a room's stage layout: its index and the type that index carries. */
export interface SeatLayoutEntry {
  seatIndex: number;
  seatType: VideoRoomSeatType;
}

/**
 * THE single source of truth for a video stage's index→seatType shape:
 * `1 + hostSeatCount + guestSeatCount` seats, index 0 = OWNER, indices
 * `1..hostSeatCount` = HOST, the remainder = GUEST.
 *
 * `VideoRoomSettings.hostSeatCount`/`guestSeatCount` only *declare* the layout;
 * the authoritative seats are the `video_room_seats` rows. Everything that
 * materialises those rows — room creation, `configureLayout`, and the cold-cache
 * backfill in `VideoRoomSeatStateService.rebuild` — must build them here. A second
 * copy of this loop is exactly how the declared layout and the stored rows drift
 * apart (the SEAT_FULL-on-an-empty-room bug: settings said 10 seats, zero rows
 * existed, so `findOpenSeat` searched an empty array).
 */
export function buildSeatLayout(hostSeatCount: number, guestSeatCount: number): SeatLayoutEntry[] {
  const total = 1 + hostSeatCount + guestSeatCount;
  const layout: SeatLayoutEntry[] = [];
  for (let i = 0; i < total; i++) {
    layout.push({
      seatIndex: i,
      seatType:
        i === VIDEO_ROOM_OWNER_SEAT_INDEX
          ? VideoRoomSeatType.OWNER
          : i <= hostSeatCount
            ? VideoRoomSeatType.HOST
            : VideoRoomSeatType.GUEST,
    });
  }
  return layout;
}

/**
 * Fold the stored status + a `metadata.reason` + overlay flags (a pending invite
 * or request targeting this seat) into the client-facing display status.
 */
export function displayStatusFor(
  entry: { status: VideoRoomSeatStatus; reason: string | null },
  overlays: { invited?: boolean; requested?: boolean },
): DisplayStatus {
  if (entry.status === VideoRoomSeatStatus.LOCKED) {
    if (entry.reason === 'maintenance') return 'MAINTENANCE';
    if (entry.reason === 'disabled') return 'DISABLED';
    return 'LOCKED';
  }
  // A pending invite surfaces as INVITED whether or not the seat is also held RESERVED.
  if (
    overlays.invited &&
    (entry.status === VideoRoomSeatStatus.RESERVED || entry.status === VideoRoomSeatStatus.EMPTY)
  ) {
    return 'INVITED';
  }
  if (entry.status === VideoRoomSeatStatus.EMPTY && overlays.requested) return 'REQUESTED';
  return entry.status as DisplayStatus;
}
