import { VideoRoomPresenceState, ViewerStatus } from '../enums';

/**
 * Pure projection of the member presence FSM to the viewer-facing vocabulary
 * (VR-6). No new state machine — derivePresenceState remains the single source
 * of truth; this only relabels for the audience surface.
 */
export function toViewerPresence(state: VideoRoomPresenceState): ViewerStatus {
  switch (state) {
    case VideoRoomPresenceState.ONLINE:
    case VideoRoomPresenceState.CONNECTING:
      return ViewerStatus.WATCHING;
    case VideoRoomPresenceState.IDLE:
      return ViewerStatus.BACKGROUND;
    case VideoRoomPresenceState.RECONNECTING:
    case VideoRoomPresenceState.DISCONNECTED:
      return ViewerStatus.RECONNECTING;
    case VideoRoomPresenceState.LEFT:
      return ViewerStatus.LEFT;
    case VideoRoomPresenceState.OFFLINE:
    default:
      return ViewerStatus.OFFLINE;
  }
}
