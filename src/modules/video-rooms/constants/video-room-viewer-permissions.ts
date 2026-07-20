/**
 * The read-only capability set a video-room VIEWER holds (VR-6). Surfaced by
 * GET /viewer/me for the client. Media capabilities (publish/camera/mic) and
 * seat occupancy remain seat-derived and are listed here as hard-false so the
 * client can render them — they are NOT granted here.
 *
 * LEARNING-CONTRIBUTION POINT: these booleans are the product-policy default;
 * canRequestSeat / canShareRoom / canFollowHost are the intended policy levers.
 */
export const VIEWER_CAPABILITIES = {
  canReceiveStreams: true,
  canViewParticipants: true,
  canViewSeats: true,
  canViewRoomInfo: true,
  canRequestSeat: true,
  canReportUser: true,
  canShareRoom: true,
  canFollowHost: true,
  canPublishCamera: false,
  canPublishAudio: false,
  canOccupySeat: false,
  canMuteOthers: false,
  canManageRoom: false,
} as const;

export type ViewerCapability = keyof typeof VIEWER_CAPABILITIES;

/** True if a viewer holds `cap`. */
export function videoRoomViewerCan(cap: ViewerCapability): boolean {
  return VIEWER_CAPABILITIES[cap];
}
