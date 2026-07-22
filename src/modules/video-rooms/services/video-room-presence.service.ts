import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import {
  videoRoomHostsKey,
  videoRoomParticipantsKey,
  videoRoomViewersKey,
} from '../constants/video-room.constants';
import type { IRoomPresenceManager } from '../interfaces/room-presence-manager.interface';

/**
 * Role-scoped room presence (VR-0 foundation primitive): three Redis sets per
 * room — viewers (audience), hosts, and seat-holders (participants) — so every
 * API instance sees the same live counts. All keys are hash-tagged on the room
 * id, so `clearRoom`'s multi-key DEL stays on one Cluster slot. Generic per-user
 * online/room presence is owned by the infra SocketManager/PresenceService at the
 * socket layer; this class tracks only the video-room role sets. Pure counting —
 * no capacity/permission gating.
 */
@Injectable()
export class VideoRoomPresenceService implements IRoomPresenceManager {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  // ---- Viewers (audience) ----

  async addViewer(roomId: string, userId: string): Promise<void> {
    await this.redis.sadd(videoRoomViewersKey(roomId), userId);
  }

  async removeViewer(roomId: string, userId: string): Promise<void> {
    await this.redis.srem(videoRoomViewersKey(roomId), userId);
  }

  async isViewer(roomId: string, userId: string): Promise<boolean> {
    return (await this.redis.sismember(videoRoomViewersKey(roomId), userId)) === 1;
  }

  async viewerCount(roomId: string): Promise<number> {
    return this.redis.scard(videoRoomViewersKey(roomId));
  }

  // ---- Hosts ----

  async addHost(roomId: string, userId: string): Promise<void> {
    await this.redis.sadd(videoRoomHostsKey(roomId), userId);
  }

  async removeHost(roomId: string, userId: string): Promise<void> {
    await this.redis.srem(videoRoomHostsKey(roomId), userId);
  }

  async isHost(roomId: string, userId: string): Promise<boolean> {
    return (await this.redis.sismember(videoRoomHostsKey(roomId), userId)) === 1;
  }

  async hostCount(roomId: string): Promise<number> {
    return this.redis.scard(videoRoomHostsKey(roomId));
  }

  // ---- Participants (seat holders) ----

  async addParticipant(roomId: string, userId: string): Promise<void> {
    await this.redis.sadd(videoRoomParticipantsKey(roomId), userId);
  }

  async removeParticipant(roomId: string, userId: string): Promise<void> {
    await this.redis.srem(videoRoomParticipantsKey(roomId), userId);
  }

  async isParticipant(roomId: string, userId: string): Promise<boolean> {
    return (await this.redis.sismember(videoRoomParticipantsKey(roomId), userId)) === 1;
  }

  async participantCount(roomId: string): Promise<number> {
    return this.redis.scard(videoRoomParticipantsKey(roomId));
  }

  // ---- Teardown ----

  async clearRoom(roomId: string): Promise<void> {
    // All three keys share the {roomId} hash-tag → single-slot, Cluster-safe DEL.
    await this.redis.del(
      videoRoomViewersKey(roomId),
      videoRoomHostsKey(roomId),
      videoRoomParticipantsKey(roomId),
    );
  }
}
