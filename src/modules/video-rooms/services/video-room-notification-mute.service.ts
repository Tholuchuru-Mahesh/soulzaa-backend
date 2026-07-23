import { Injectable } from '@nestjs/common';
import { RedisService } from 'src/infra/redis/redis.service';
import { videoRoomNotificationMuteKey } from '../constants/video-room-notification.constants';
import { VideoRoomNotificationMuteRepository } from '../repositories/video-room-notification-mute.repository';

/**
 * Per-room mute (VR-15). Durable table is the source of truth; a Redis set is a
 * hot-path read-cache for the dispatcher's per-recipient gate. isMuted trusts a
 * positive cache hit and falls back to the table on a miss (then warms the set).
 */
@Injectable()
export class VideoRoomNotificationMuteService {
  constructor(
    private readonly repo: VideoRoomNotificationMuteRepository,
    private readonly redis: RedisService,
  ) {}

  async mute(userId: string, roomId: string): Promise<void> {
    await this.repo.create(userId, roomId);
    await this.redis.client.sadd(videoRoomNotificationMuteKey(userId), roomId);
  }

  /**
   * Known trade-off: isMuted trusts a Redis cache HIT unconditionally, and mute's
   * cache write self-heals via the miss -> DB -> re-warm path in isMuted. But if
   * this srem fails after repo.remove has already succeeded, the Redis set can
   * retain a stale entry, causing temporary over-suppression of notifications
   * until the next mute/unmute call for this (userId, roomId) pair corrects it.
   */
  async unmute(userId: string, roomId: string): Promise<void> {
    await this.repo.remove(userId, roomId);
    await this.redis.client.srem(videoRoomNotificationMuteKey(userId), roomId);
  }

  async isMuted(userId: string, roomId: string): Promise<boolean> {
    const cached = await this.redis.client.sismember(videoRoomNotificationMuteKey(userId), roomId);
    if (cached === 1) return true;
    const persisted = await this.repo.exists(userId, roomId);
    if (persisted) await this.redis.client.sadd(videoRoomNotificationMuteKey(userId), roomId);
    return persisted;
  }

  listMuted(userId: string): Promise<string[]> {
    return this.repo.list(userId);
  }
}
