import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  VIDEO_ROOM_EVENTS,
  RoomCreatedEvent,
  RoomClosedEvent,
  UserJoinedEvent,
  UserLeftEvent,
  ViewerJoinedEvent,
  ViewerLeftEvent,
} from '../events/video-room.events';
import { VideoRoomAnalyticsProjectionRepository } from '../repositories/video-room-analytics-projection.repository';
import { VideoRoomAnalyticsCacheService } from '../services/video-room-analytics-cache.service';

@Injectable()
export class VideoRoomAnalyticsListener {
  private readonly logger = new Logger(VideoRoomAnalyticsListener.name);

  constructor(
    private readonly cacheService: VideoRoomAnalyticsCacheService,
    private readonly repository: VideoRoomAnalyticsProjectionRepository,
  ) {}

  private getDateKey(date: Date = new Date()): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  }

  @OnEvent(VIDEO_ROOM_EVENTS.CREATED, { async: true })
  async handleRoomCreated(event: RoomCreatedEvent): Promise<void> {
    try {
      await this.cacheService.incrementActiveRooms(event.payload.roomId);
      await this.cacheService.incrementActiveHosts(event.payload.ownerId);

      const dateKey = this.getDateKey();
      await this.repository.upsertCreatorDailyStat({
        dateKey,
        userId: event.payload.ownerId,
        roomsHosted: 1,
      });
    } catch (err: any) {
      this.logger.error(`Error processing RoomCreated event: ${err.message}`);
    }
  }

  @OnEvent(VIDEO_ROOM_EVENTS.CLOSED, { async: true })
  async handleRoomClosed(event: RoomClosedEvent): Promise<void> {
    try {
      await this.cacheService.decrementActiveRooms(event.payload.roomId);
      await this.cacheService.decrementActiveHosts(event.payload.ownerId);

      const dateKey = this.getDateKey();
      await this.repository.upsertRoomDailyStat({
        dateKey,
        roomId: event.payload.roomId,
        speakingSeconds: BigInt(event.payload.durationSeconds || 0),
      });
    } catch (err: any) {
      this.logger.error(`Error processing RoomClosed event: ${err.message}`);
    }
  }

  @OnEvent(VIDEO_ROOM_EVENTS.USER_JOINED, { async: true })
  async handleUserJoined(event: UserJoinedEvent): Promise<void> {
    try {
      await this.cacheService.trackActiveParticipant(event.payload.userId);

      const dateKey = this.getDateKey();
      await this.repository.upsertRoomDailyStat({
        dateKey,
        roomId: event.payload.roomId,
        joins: 1,
        peakParticipants: event.payload.participantCount,
      });
    } catch (err: any) {
      this.logger.error(`Error processing UserJoined event: ${err.message}`);
    }
  }

  @OnEvent(VIDEO_ROOM_EVENTS.USER_LEFT, { async: true })
  async handleUserLeft(event: UserLeftEvent): Promise<void> {
    try {
      await this.cacheService.untrackActiveParticipant(event.payload.userId);
    } catch (err: any) {
      this.logger.error(`Error processing UserLeft event: ${err.message}`);
    }
  }

  @OnEvent(VIDEO_ROOM_EVENTS.VIEWER_JOINED, { async: true })
  async handleViewerJoined(event: ViewerJoinedEvent): Promise<void> {
    try {
      await this.cacheService.trackActiveViewer(event.payload.userId);

      const dateKey = this.getDateKey();
      await this.repository.upsertRoomDailyStat({
        dateKey,
        roomId: event.payload.roomId,
        uniqueVisitors: 1,
      });
    } catch (err: any) {
      this.logger.error(`Error processing ViewerJoined event: ${err.message}`);
    }
  }

  @OnEvent(VIDEO_ROOM_EVENTS.VIEWER_LEFT, { async: true })
  async handleViewerLeft(event: ViewerLeftEvent): Promise<void> {
    try {
      await this.cacheService.untrackActiveViewer(event.payload.userId);
    } catch (err: any) {
      this.logger.error(`Error processing ViewerLeft event: ${err.message}`);
    }
  }
}
