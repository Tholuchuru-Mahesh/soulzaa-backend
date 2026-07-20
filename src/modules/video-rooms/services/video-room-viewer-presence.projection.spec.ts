import { VideoRoomPresenceState, ViewerStatus } from '../enums';
import { toViewerPresence } from './video-room-viewer-presence.projection';

describe('toViewerPresence', () => {
  it.each([
    [VideoRoomPresenceState.ONLINE, ViewerStatus.WATCHING],
    [VideoRoomPresenceState.CONNECTING, ViewerStatus.WATCHING],
    [VideoRoomPresenceState.IDLE, ViewerStatus.BACKGROUND],
    [VideoRoomPresenceState.RECONNECTING, ViewerStatus.RECONNECTING],
    [VideoRoomPresenceState.DISCONNECTED, ViewerStatus.RECONNECTING],
    [VideoRoomPresenceState.LEFT, ViewerStatus.LEFT],
    [VideoRoomPresenceState.OFFLINE, ViewerStatus.OFFLINE],
  ])('%s → %s', (state, expected) => {
    expect(toViewerPresence(state)).toBe(expected);
  });
});
