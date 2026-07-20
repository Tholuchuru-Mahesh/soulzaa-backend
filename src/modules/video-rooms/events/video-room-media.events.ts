import { DomainEvent } from 'src/common/events';
import type { AudioOutput, ConnectionType, MediaStreamState, VideoQualityProfile } from '../enums';

/**
 * Video-room media domain events on the EVENT_BUS (VR-5). The module's own
 * media socket listener bridges these to `video_room.media_*` broadcasts;
 * downstream domains (analytics, moderation) may subscribe without importing
 * this module. Every payload carries the snapshot `version` so clients
 * reconcile out-of-order syncs against the Redis-authoritative media state.
 *
 * Naming note: `MediaStreamPublishedEvent` / `MediaStreamStoppedEvent` are
 * distinct from the pre-existing `StreamStartedEvent` / `StreamStoppedEvent`
 * in `video-room.events.ts` (VR-0's room-level "is anyone streaming" signal).
 * The `Media` prefix avoids colliding with those class names while both
 * modules evolve independently.
 */
export const VIDEO_ROOM_MEDIA_EVENTS = {
  SESSION_CREATED: 'video_room.media_session_created',
  SESSION_CLOSED: 'video_room.media_session_closed',
  STREAM_PUBLISHED: 'video_room.media_stream_published',
  STREAM_STOPPED: 'video_room.media_stream_stopped',
  STREAM_PAUSED: 'video_room.media_stream_paused',
  STREAM_RESUMED: 'video_room.media_stream_resumed',
  CAMERA_ENABLED: 'video_room.media_camera_enabled',
  CAMERA_DISABLED: 'video_room.media_camera_disabled',
  MIC_ENABLED: 'video_room.media_mic_enabled',
  MIC_DISABLED: 'video_room.media_mic_disabled',
  SUBSCRIBED: 'video_room.media_subscribed',
  UNSUBSCRIBED: 'video_room.media_unsubscribed',
  BEAUTY_CHANGED: 'video_room.media_beauty_changed',
  QUALITY_CHANGED: 'video_room.media_quality_changed',
  AUDIO_OUTPUT_CHANGED: 'video_room.media_audio_output_changed',
  STREAM_STATE_CHANGED: 'video_room.media_stream_state_changed',
  STREAM_RECOVERED: 'video_room.media_stream_recovered',
  MEDIA_RECOVERED: 'video_room.media_recovered',
  MEDIA_FAILED: 'video_room.media_failed',
  STATE_SYNC: 'video_room.media_state_sync',
} as const;

export type VideoRoomMediaEvent =
  (typeof VIDEO_ROOM_MEDIA_EVENTS)[keyof typeof VIDEO_ROOM_MEDIA_EVENTS];

/** Fields every media event payload carries. */
interface MediaEventBase {
  roomId: string;
  version: number;
  userId: string;
}

export class MediaSessionCreatedEvent extends DomainEvent<
  MediaEventBase & { seatIndex: number | null; role: ConnectionType }
> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.SESSION_CREATED;
}

export class MediaSessionClosedEvent extends DomainEvent<
  MediaEventBase & { durationSeconds: number }
> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.SESSION_CLOSED;
}

export class MediaStreamPublishedEvent extends DomainEvent<
  MediaEventBase & { streamId: string; streamState: MediaStreamState }
> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_PUBLISHED;
}

export class MediaStreamStoppedEvent extends DomainEvent<
  MediaEventBase & { streamId: string | null }
> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_STOPPED;
}

export class StreamPausedEvent extends DomainEvent<MediaEventBase> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_PAUSED;
}

export class StreamResumedEvent extends DomainEvent<MediaEventBase> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_RESUMED;
}

export class CameraEnabledEvent extends DomainEvent<MediaEventBase> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.CAMERA_ENABLED;
}

export class CameraDisabledEvent extends DomainEvent<MediaEventBase> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.CAMERA_DISABLED;
}

export class MicEnabledEvent extends DomainEvent<MediaEventBase> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.MIC_ENABLED;
}

export class MicDisabledEvent extends DomainEvent<MediaEventBase & { byAdmin: boolean }> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.MIC_DISABLED;
}

export class SubscribedEvent extends DomainEvent<MediaEventBase & { targetUserId: string }> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.SUBSCRIBED;
}

export class UnsubscribedEvent extends DomainEvent<MediaEventBase & { targetUserId: string }> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.UNSUBSCRIBED;
}

export class BeautyChangedEvent extends DomainEvent<
  MediaEventBase & { enabled: boolean; level: number }
> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.BEAUTY_CHANGED;
}

export class QualityChangedEvent extends DomainEvent<
  MediaEventBase & { profile: VideoQualityProfile; bitrateKbps: number }
> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.QUALITY_CHANGED;
}

export class AudioOutputChangedEvent extends DomainEvent<MediaEventBase & { output: AudioOutput }> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.AUDIO_OUTPUT_CHANGED;
}

export class StreamStateChangedEvent extends DomainEvent<
  MediaEventBase & { streamState: MediaStreamState }
> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_STATE_CHANGED;
}

export class StreamRecoveredEvent extends DomainEvent<
  MediaEventBase & { streamId: string | null }
> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.STREAM_RECOVERED;
}

export class MediaRecoveredEvent extends DomainEvent<MediaEventBase> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.MEDIA_RECOVERED;
}

export class MediaFailedEvent extends DomainEvent<MediaEventBase & { reason: string }> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.MEDIA_FAILED;
}

export class MediaStateSyncEvent extends DomainEvent<MediaEventBase> {
  readonly name = VIDEO_ROOM_MEDIA_EVENTS.STATE_SYNC;
}
