import { Injectable, Logger } from '@nestjs/common';
import { VideoRoomStatus } from '@prisma/client';
import type { IVideoRoomsService } from '../interfaces/video-rooms.service.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';

/**
 * Video Rooms foundation service (VR-0). Implements the public cross-module
 * contract (IVideoRoomsService) other domains resolve by token. The room
 * lifecycle/business surface (create/edit/end, join/leave, seats, streaming)
 * lands in later phases; VR-0 exposes the one liveness query downstream domains
 * (analytics, rankings, gifts) plausibly need.
 */
@Injectable()
export class VideoRoomsService implements IVideoRoomsService {
  private readonly logger = new Logger(VideoRoomsService.name);

  constructor(private readonly repo: VideoRoomsRepository) {}

  async isRoomLive(roomId: string): Promise<boolean> {
    const room = await this.repo.findById(roomId);
    return room?.status === VideoRoomStatus.LIVE;
  }
}
