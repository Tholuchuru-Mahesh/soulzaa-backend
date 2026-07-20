import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_MEDIA_EVENTS,
  type AudioOutputChangedEvent,
  type BeautyChangedEvent,
  type CameraDisabledEvent,
  type CameraEnabledEvent,
  type MediaFailedEvent,
  type MediaRecoveredEvent,
  type MediaSessionClosedEvent,
  type MediaSessionCreatedEvent,
  type MediaStateSyncEvent,
  type MediaStreamPublishedEvent,
  type MediaStreamStoppedEvent,
  type MicDisabledEvent,
  type MicEnabledEvent,
  type QualityChangedEvent,
  type StreamPausedEvent,
  type StreamRecoveredEvent,
  type StreamResumedEvent,
  type StreamStateChangedEvent,
  type SubscribedEvent,
  type UnsubscribedEvent,
} from '../events/video-room-media.events';

/**
 * Bridges VR-5 media domain events on the EVENT_BUS to client-facing
 * `video_room.media_*` / `video_room.stream_*` broadcasts into the
 * `/video-room` namespace room. Mirrors `VideoRoomSeatSocketListener`; media
 * services never touch sockets. Heartbeat/quality-sample events are
 * intentionally NOT subscribed here (monitoring-only, handled by the metrics
 * listener).
 */
@Injectable()
export class VideoRoomMediaSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<MediaSessionCreatedEvent>(VIDEO_ROOM_MEDIA_EVENTS.SESSION_CREATED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.MEDIA_JOINED, e.payload),
    );
    this.bus.subscribe<MediaSessionClosedEvent>(VIDEO_ROOM_MEDIA_EVENTS.SESSION_CLOSED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.MEDIA_LEFT, e.payload),
    );
    this.bus.subscribe<MediaStreamPublishedEvent>(VIDEO_ROOM_MEDIA_EVENTS.STREAM_PUBLISHED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.STREAM_PUBLISHED, e.payload),
    );
    this.bus.subscribe<MediaStreamStoppedEvent>(VIDEO_ROOM_MEDIA_EVENTS.STREAM_STOPPED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.STREAM_STOPPED, e.payload),
    );
    this.bus.subscribe<StreamPausedEvent>(VIDEO_ROOM_MEDIA_EVENTS.STREAM_PAUSED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.STREAM_PAUSED, e.payload),
    );
    this.bus.subscribe<StreamResumedEvent>(VIDEO_ROOM_MEDIA_EVENTS.STREAM_RESUMED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.STREAM_RESUMED, e.payload),
    );
    this.bus.subscribe<CameraEnabledEvent>(VIDEO_ROOM_MEDIA_EVENTS.CAMERA_ENABLED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.CAMERA_ON, e.payload),
    );
    this.bus.subscribe<CameraDisabledEvent>(VIDEO_ROOM_MEDIA_EVENTS.CAMERA_DISABLED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.CAMERA_OFF, e.payload),
    );
    this.bus.subscribe<MicEnabledEvent>(VIDEO_ROOM_MEDIA_EVENTS.MIC_ENABLED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.MIC_ON, e.payload),
    );
    this.bus.subscribe<MicDisabledEvent>(VIDEO_ROOM_MEDIA_EVENTS.MIC_DISABLED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.MIC_OFF, e.payload),
    );
    this.bus.subscribe<SubscribedEvent>(VIDEO_ROOM_MEDIA_EVENTS.SUBSCRIBED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.MEDIA_SUBSCRIBED, e.payload),
    );
    this.bus.subscribe<UnsubscribedEvent>(VIDEO_ROOM_MEDIA_EVENTS.UNSUBSCRIBED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.MEDIA_UNSUBSCRIBED, e.payload),
    );
    this.bus.subscribe<BeautyChangedEvent>(VIDEO_ROOM_MEDIA_EVENTS.BEAUTY_CHANGED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.BEAUTY_CHANGED, e.payload),
    );
    this.bus.subscribe<QualityChangedEvent>(VIDEO_ROOM_MEDIA_EVENTS.QUALITY_CHANGED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.QUALITY_CHANGED, e.payload),
    );
    this.bus.subscribe<AudioOutputChangedEvent>(VIDEO_ROOM_MEDIA_EVENTS.AUDIO_OUTPUT_CHANGED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.AUDIO_OUTPUT_CHANGED, e.payload),
    );
    this.bus.subscribe<StreamStateChangedEvent>(VIDEO_ROOM_MEDIA_EVENTS.STREAM_STATE_CHANGED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.STREAM_STATE_CHANGED, e.payload),
    );
    this.bus.subscribe<StreamRecoveredEvent>(VIDEO_ROOM_MEDIA_EVENTS.STREAM_RECOVERED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.STREAM_RECOVERED, e.payload),
    );
    this.bus.subscribe<MediaRecoveredEvent>(VIDEO_ROOM_MEDIA_EVENTS.MEDIA_RECOVERED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.MEDIA_RECOVERED, e.payload),
    );
    this.bus.subscribe<MediaFailedEvent>(VIDEO_ROOM_MEDIA_EVENTS.MEDIA_FAILED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.STREAM_FAILED, e.payload),
    );
    this.bus.subscribe<MediaStateSyncEvent>(VIDEO_ROOM_MEDIA_EVENTS.STATE_SYNC, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.MEDIA_STATE_SYNC, e.payload),
    );
  }

  private emit(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
