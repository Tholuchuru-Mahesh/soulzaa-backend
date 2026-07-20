import { VideoRoomPresenceState } from '../enums';
import type { VideoRoomSessionRecord } from '../interfaces/room-session-manager.interface';
import { derivePresenceState } from './video-room-presence-state';

const cfg = { heartbeatIntervalSeconds: 25, reconnectTimeoutSeconds: 120, idleTimeoutSeconds: 300 };
const NOW = 1_000_000_000_000;

/** Build a session record last seen `secAgo` seconds before NOW. */
function at(
  secAgo: number,
  over: Partial<VideoRoomSessionRecord> = {},
): Pick<
  VideoRoomSessionRecord,
  'presenceState' | 'inBackground' | 'lastSeenAt' | 'reconnectCount'
> {
  return {
    presenceState: VideoRoomPresenceState.ONLINE,
    inBackground: false,
    lastSeenAt: new Date(NOW - secAgo * 1000).toISOString(),
    reconnectCount: 1,
    ...over,
  };
}

describe('derivePresenceState', () => {
  it('OFFLINE when there is no session', () => {
    expect(derivePresenceState(null, NOW, cfg)).toBe(VideoRoomPresenceState.OFFLINE);
  });

  it('ONLINE when fresh and foreground', () => {
    expect(derivePresenceState(at(5), NOW, cfg)).toBe(VideoRoomPresenceState.ONLINE);
  });

  it('ONLINE exactly at the miss boundary (age == heartbeat x MISS_FACTOR)', () => {
    expect(derivePresenceState(at(50), NOW, cfg)).toBe(VideoRoomPresenceState.ONLINE);
  });

  it('IDLE when heartbeating but backgrounded', () => {
    expect(derivePresenceState(at(5, { inBackground: true }), NOW, cfg)).toBe(
      VideoRoomPresenceState.IDLE,
    );
  });

  it('RECONNECTING dominates IDLE once heartbeats are missed', () => {
    expect(derivePresenceState(at(60, { inBackground: true }), NOW, cfg)).toBe(
      VideoRoomPresenceState.RECONNECTING,
    );
  });

  it('RECONNECTING when past the miss threshold but within grace', () => {
    expect(derivePresenceState(at(60), NOW, cfg)).toBe(VideoRoomPresenceState.RECONNECTING);
  });

  it('RECONNECTING exactly at the grace boundary (age == reconnectTimeout)', () => {
    expect(derivePresenceState(at(120), NOW, cfg)).toBe(VideoRoomPresenceState.RECONNECTING);
  });

  it('LEFT once the grace window has elapsed', () => {
    expect(derivePresenceState(at(130), NOW, cfg)).toBe(VideoRoomPresenceState.LEFT);
  });

  it('LEFT is a sticky terminal state', () => {
    expect(
      derivePresenceState(at(1, { presenceState: VideoRoomPresenceState.LEFT }), NOW, cfg),
    ).toBe(VideoRoomPresenceState.LEFT);
  });

  it('CONNECTING within the first-beat window for a brand-new session', () => {
    expect(
      derivePresenceState(
        at(10, { presenceState: VideoRoomPresenceState.CONNECTING, reconnectCount: 0 }),
        NOW,
        cfg,
      ),
    ).toBe(VideoRoomPresenceState.CONNECTING);
  });

  it('DISCONNECTED stays DISCONNECTED while within grace', () => {
    expect(
      derivePresenceState(at(30, { presenceState: VideoRoomPresenceState.DISCONNECTED }), NOW, cfg),
    ).toBe(VideoRoomPresenceState.DISCONNECTED);
  });

  it('DISCONNECTED past the grace window becomes LEFT', () => {
    expect(
      derivePresenceState(
        at(130, { presenceState: VideoRoomPresenceState.DISCONNECTED }),
        NOW,
        cfg,
      ),
    ).toBe(VideoRoomPresenceState.LEFT);
  });
});
