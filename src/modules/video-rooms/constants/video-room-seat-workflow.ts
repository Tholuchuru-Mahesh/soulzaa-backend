import { VideoRoomInvitationStatus, VideoRoomSeatRequestStatus } from '@prisma/client';

/**
 * VR-8 — the seat request / invitation state machines, declared as transition
 * tables rather than scattered conditionals.
 *
 * With seven states each, most of the 49 possible pairs are illegal; encoding
 * the legal ones once means services make a single guard call, and a future
 * edit that opens an unsafe path fails a test instead of corrupting rows.
 *
 * Request lifecycle:
 *   PENDING  → ACCEPTED (approved; seating in flight) | REJECTED | CANCELLED | EXPIRED
 *   ACCEPTED → PROMOTED (seated)                      | FAILED   (seating threw)
 *   FAILED   → PENDING  (explicit retry)
 *   EXPIRED  → PENDING  (restore on reconnect, original createdAt preserved)
 *
 * Invitation lifecycle:
 *   PENDING   → DELIVERED | ACCEPTED | REJECTED | CANCELLED | EXPIRED
 *   DELIVERED → ACCEPTED  | REJECTED | CANCELLED | EXPIRED  | FAILED
 *   FAILED    → PENDING   (explicit retry)
 */

const R = VideoRoomSeatRequestStatus;
const I = VideoRoomInvitationStatus;

export const SEAT_REQUEST_TRANSITIONS: Readonly<
  Record<VideoRoomSeatRequestStatus, readonly VideoRoomSeatRequestStatus[]>
> = Object.freeze({
  [R.PENDING]: [R.ACCEPTED, R.REJECTED, R.CANCELLED, R.EXPIRED],
  [R.ACCEPTED]: [R.PROMOTED, R.FAILED],
  [R.PROMOTED]: [],
  [R.FAILED]: [R.PENDING],
  [R.EXPIRED]: [R.PENDING],
  [R.REJECTED]: [],
  [R.CANCELLED]: [],
});

export const SEAT_INVITATION_TRANSITIONS: Readonly<
  Record<VideoRoomInvitationStatus, readonly VideoRoomInvitationStatus[]>
> = Object.freeze({
  [I.PENDING]: [I.DELIVERED, I.ACCEPTED, I.REJECTED, I.CANCELLED, I.EXPIRED, I.FAILED],
  [I.DELIVERED]: [I.ACCEPTED, I.REJECTED, I.CANCELLED, I.EXPIRED, I.FAILED],
  [I.ACCEPTED]: [],
  [I.REJECTED]: [],
  [I.CANCELLED]: [],
  [I.EXPIRED]: [],
  [I.FAILED]: [I.PENDING],
});

/** Whether a seat request may move `from` → `to`. Self-transitions are never legal. */
export function canTransitionRequest(
  from: VideoRoomSeatRequestStatus,
  to: VideoRoomSeatRequestStatus,
): boolean {
  return SEAT_REQUEST_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Whether an invitation may move `from` → `to`. */
export function canTransitionInvitation(
  from: VideoRoomInvitationStatus,
  to: VideoRoomInvitationStatus,
): boolean {
  return SEAT_INVITATION_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A request status from which nothing further is possible. */
export function isTerminalRequestStatus(status: VideoRoomSeatRequestStatus): boolean {
  return SEAT_REQUEST_TRANSITIONS[status].length === 0;
}

/** An invitation status from which nothing further is possible. */
export function isTerminalInvitationStatus(status: VideoRoomInvitationStatus): boolean {
  return SEAT_INVITATION_TRANSITIONS[status].length === 0;
}
