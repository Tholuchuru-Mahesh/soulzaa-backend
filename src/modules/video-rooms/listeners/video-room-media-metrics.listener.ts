import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_MEDIA_EVENTS } from '../events/video-room-media.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * Keeps the VR-5 media Prometheus metrics current by subscribing to the same
 * media domain events the media socket listener consumes — monitoring stays
 * decoupled from the session/publish workflows (one event, many independent
 * consumers), mirroring `VideoRoomSeatMetricsListener`. Monitoring-only; it
 * never touches sockets.
 */
@Injectable()
export class VideoRoomMediaMetricsListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    const M = VIDEO_ROOM_MEDIA_EVENTS;
    this.bus.subscribe(M.SESSION_CREATED, () => this.metrics.incMediaSession());
    this.bus.subscribe(M.STREAM_PUBLISHED, () => {
      this.metrics.incPublish();
      this.metrics.incActiveStream();
    });
    this.bus.subscribe(M.STREAM_STOPPED, () => this.metrics.decActiveStream());
    this.bus.subscribe(M.MEDIA_FAILED, () => this.metrics.incMediaFailure());
    this.bus.subscribe(M.MEDIA_RECOVERED, () => this.metrics.incRecoverySuccess());
    this.bus.subscribe(M.CAMERA_ENABLED, () => this.metrics.incCameraToggle());
    this.bus.subscribe(M.CAMERA_DISABLED, () => this.metrics.incCameraToggle());
    this.bus.subscribe(M.MIC_ENABLED, () => this.metrics.incMicToggle());
    this.bus.subscribe(M.MIC_DISABLED, () => this.metrics.incMicToggle());
    this.bus.subscribe(M.BEAUTY_CHANGED, () => this.metrics.incBeautyChange());
    this.bus.subscribe(M.QUALITY_CHANGED, () => this.metrics.incBitrateChange());
  }
}
