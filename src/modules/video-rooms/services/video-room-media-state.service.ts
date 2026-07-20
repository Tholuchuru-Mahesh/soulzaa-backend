import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  AudioOutput,
  CameraFacing,
  ConnectionStatus,
  ConnectionType,
  MediaStreamKind,
  MediaStreamState,
  VideoQualityProfile,
} from '../enums';
import { loadVideoRoomConfig } from '../config/video-room.config';
import { MEDIA_PROVIDER, type IMediaProvider } from '../interfaces/media-provider.interface';
import { DEFAULT_BEAUTY } from '../media/beauty-settings';
import type {
  MediaParticipant,
  MediaStageMutation,
  MediaStageSnapshot,
} from '../media/media-stage';
import { videoRoomMediaStateKey } from '../constants/video-room.constants';
import { VideoRoomMediaSessionRepository } from '../repositories/video-room-media-session.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';

/**
 * Redis-authoritative versioned media snapshot — the pure primitive behind the
 * media stage (mirrors VideoRoomSeatStateService). NON-locking: the caller
 * (VideoRoomMediaService.mutateStage) holds videoRoomMediaLockKey. `rebuild`
 * reconstructs a cold snapshot from durable active sessions + the room handle.
 */
@Injectable()
export class VideoRoomMediaStateService {
  private readonly ttl: number;

  constructor(
    private readonly cache: CacheService,
    private readonly sessions: VideoRoomMediaSessionRepository,
    private readonly rooms: VideoRoomsRepository,
    @Inject(MEDIA_PROVIDER) private readonly provider: IMediaProvider,
    config: ConfigService,
  ) {
    this.ttl = loadVideoRoomConfig(config).stateTtlSeconds;
  }

  /** The cached live snapshot, or null when cold. */
  async getSnapshot(roomId: string): Promise<MediaStageSnapshot | null> {
    return this.cache.get<MediaStageSnapshot>(videoRoomMediaStateKey(roomId));
  }

  /** Rebuild a cold snapshot from active sessions + the room's zego handle. version = 1. */
  async rebuild(roomId: string): Promise<MediaStageSnapshot> {
    const [room, active] = await Promise.all([
      this.rooms.findById(roomId),
      this.sessions.listActive(roomId),
    ]);
    const nowIso = new Date().toISOString();
    const participants: MediaParticipant[] = active.map((s) => ({
      userId: s.userId,
      seatIndex: null,
      role: s.role === 'PUBLISHER' ? ConnectionType.PUBLISHER : ConnectionType.SUBSCRIBER,
      connection: ConnectionStatus.CONNECTED,
      streamId: null,
      streamKind: MediaStreamKind.CAMERA,
      streamState: MediaStreamState.CREATED,
      camera: {
        on: !s.selfMutedVideo,
        facing: (s.cameraFacing as CameraFacing) ?? CameraFacing.FRONT,
      },
      mic: { on: !s.selfMutedAudio, selfMuted: s.selfMutedAudio, adminMuted: false },
      audioOutput: AudioOutput.SPEAKER,
      quality: VideoQualityProfile.ADAPTIVE,
      beauty: { ...DEFAULT_BEAUTY },
      subscriptions: [],
      joinedAt: nowIso,
      lastHeartbeatAt: nowIso,
    }));
    const snapshot: MediaStageSnapshot = {
      roomId,
      version: 1,
      updatedAt: nowIso,
      mediaRoomId: room?.zegoRoomId ?? '',
      provider: this.provider.kind,
      participants,
    };
    await this.cache.set(videoRoomMediaStateKey(roomId), snapshot, this.ttl);
    return snapshot;
  }

  /**
   * Merge `patch` onto `base`, bump the monotonic version, and persist. NON-locking —
   * the caller must already hold `videoRoomMediaLockKey(roomId)`.
   */
  async commit(
    roomId: string,
    base: MediaStageSnapshot,
    patch: MediaStageMutation,
  ): Promise<MediaStageSnapshot> {
    const next: MediaStageSnapshot = {
      ...base,
      ...patch,
      roomId,
      version: base.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.cache.set(videoRoomMediaStateKey(roomId), next, this.ttl);
    return next;
  }

  /** Drop the live snapshot (room closed / reset); DB history is retained. */
  async clear(roomId: string): Promise<void> {
    await this.cache.del(videoRoomMediaStateKey(roomId));
  }
}
