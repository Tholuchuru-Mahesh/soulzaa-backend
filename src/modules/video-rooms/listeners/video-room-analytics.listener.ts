import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
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
  async handleRoomCreated(payload: { roomId: string; ownerId: string }): Promise<void> {
    try {
      await this.cacheService.incrementActiveRooms(payload.roomId);
      await this.cacheService.incrementActiveHosts(payload.ownerId);

      const dateKey = this.getDateKey();
      await this.repository.upsertCreatorDailyStat({
        dateKey,
        userId: payload.ownerId,
        roomsHosted: 1,
      });
    } catch (err: any) {
      this.logger.error(`Error processing RoomCreated event: ${err.message}`);
    }
  }

  @OnEvent(VIDEO_ROOM_EVENTS.CLOSED, { async: true })
  async handleRoomClosed(payload: {
    roomId: string;
    ownerId: string;
    durationSeconds: number;
  }): Promise<void> {
    try {
      await this.cacheService.decrementActiveRooms(payload.roomId);
      await this.cacheService.decrementActiveHosts(payload.ownerId);

      const dateKey = this.getDateKey();
      await this.repository.upsertRoomDailyStat({
        dateKey,
        roomId: payload.roomId,
        speakingSeconds: BigInt(payload.durationSeconds || 0),
      });
    } catch (err: any) {
      this.logger.error(`Error processing RoomClosed event: ${err.message}`);
    }
  }

  @OnEvent(VIDEO_ROOM_EVENTS.USER_JOINED, { async: true })
  async handleUserJoined(payload: {
    roomId: string;
    userId: string;
    participantCount: number;
  }): Promise<void> {
    try {
      await this.cacheService.trackActiveParticipant(payload.userId);

      const dateKey = this.getDateKey();
      await this.repository.upsertRoomDailyStat({
        dateKey,
        roomId: payload.roomId,
        joins: 1,
        peakParticipants: payload.participantCount,
      });
    } catch (err: any) {
      this.logger.error(`Error processing UserJoined event: ${err.message}`);
    }
  }

  @OnEvent(VIDEO_ROOM_EVENTS.USER_LEFT, { async: true })
  async handleUserLeft(payload: {
    roomId: string;
    userId: string;
    participantCount: number;
  }): Promise<void> {
    try {
      await this.cacheService.untrackActiveParticipant(payload.userId);
    } catch (err: any) {
      this.logger.error(`Error processing UserLeft event: ${err.message}`);
    }
  }

  @OnEvent(VIDEO_ROOM_EVENTS.VIEWER_JOINED, { async: true })
  async handleViewerJoined(payload: {
    roomId: string;
    userId: string;
    viewerCount: number;
  }): Promise<void> {
    try {
      await this.cacheService.trackActiveViewer(payload.userId);

      const dateKey = this.getDateKey();
      await this.repository.upsertRoomDailyStat({
        dateKey,
        roomId: payload.roomId,
        uniqueVisitors: 1,
      });
    } catch (err: any) {
      this.logger.error(`Error processing ViewerJoined event: ${err.message}`);
    }
  }

  @OnEvent(VIDEO_ROOM_EVENTS.VIEWER_LEFT, { async: true })
  async handleViewerLeft(payload: {
    roomId: string;
    userId: string;
    viewerCount: number;
  }): Promise<void> {
    try {
      await this.cacheService.untrackActiveViewer(payload.userId);
    } catch (err: any) {
      this.logger.error(`Error processing ViewerLeft event: ${err.message}`);
    }
  }
}
