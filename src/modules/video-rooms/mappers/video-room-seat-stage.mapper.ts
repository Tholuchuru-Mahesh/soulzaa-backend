import type { VideoRoomInvitation, VideoRoomSeat, VideoRoomSeatRequest } from '@prisma/client';
import { displayStatusFor } from '../constants/video-room-seat-lifecycle';
import type { SeatStageView } from '../entities/video-room-seat-stage.view';
import type { SeatEntrySnapshot, SeatStageSnapshot } from '../interfaces/seat-stage.interface';

/** Row → snapshot entry, lifting `reason`/`premium` out of the free-form metadata. */
export function seatRowToEntry(row: VideoRoomSeat): SeatEntrySnapshot {
  const meta = (row.metadata ?? {}) as { reason?: string; premium?: boolean };
  return {
    seatIndex: row.seatIndex,
    seatType: row.seatType,
    status: row.seatStatus,
    occupantUserId: row.occupantUserId,
    reservedForUserId: row.reservedForUserId,
    isLocked: row.isLocked,
    isMuted: row.isMuted,
    isVideoOn: row.isVideoOn,
    reason: meta.reason ?? null,
    premium: meta.premium === true,
  };
}

/**
 * Compose the client-facing stage view: the versioned snapshot + read-time overlays
 * (pending requests → `requestedBy` + REQUESTED, pending invitations → `invitedUserId`
 * + INVITED). Only seat-targeted (non-null `seatIndex`) requests/invitations overlay
 * onto a seat.
 */
export function toSeatStageView(
  snapshot: SeatStageSnapshot,
  pendingRequests: Pick<VideoRoomSeatRequest, 'userId' | 'seatIndex'>[],
  pendingInvitations: Pick<VideoRoomInvitation, 'inviteeUserId' | 'seatIndex'>[],
): SeatStageView {
  const requestsBySeat = new Map<number, string[]>();
  for (const req of pendingRequests) {
    if (req.seatIndex == null) continue;
    requestsBySeat.set(req.seatIndex, [...(requestsBySeat.get(req.seatIndex) ?? []), req.userId]);
  }
  const inviteBySeat = new Map<number, string>();
  for (const inv of pendingInvitations) {
    if (inv.seatIndex != null) inviteBySeat.set(inv.seatIndex, inv.inviteeUserId);
  }

  return {
    roomId: snapshot.roomId,
    version: snapshot.version,
    hostSeatCount: snapshot.hostSeatCount,
    guestSeatCount: snapshot.guestSeatCount,
    seats: snapshot.seats.map((seat) => {
      const requestedBy = requestsBySeat.get(seat.seatIndex) ?? [];
      const invitedUserId = inviteBySeat.get(seat.seatIndex) ?? null;
      return {
        seatIndex: seat.seatIndex,
        seatType: seat.seatType,
        status: seat.status,
        displayStatus: displayStatusFor(seat, {
          invited: invitedUserId != null,
          requested: requestedBy.length > 0,
        }),
        occupantUserId: seat.occupantUserId,
        reservedForUserId: seat.reservedForUserId,
        invitedUserId,
        requestedBy,
        isLocked: seat.isLocked,
        isMuted: seat.isMuted,
        isVideoOn: seat.isVideoOn,
        premium: seat.premium,
      };
    }),
  };
}
