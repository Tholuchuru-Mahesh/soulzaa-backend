import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VideoRoomPublishRole } from '@prisma/client';
import { CacheService } from 'src/infra/redis/cache.service';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { ConnectionStatus, ConnectionType, MediaStreamState } from '../enums';
import { loadVideoRoomConfig, type VideoRoomConfig } from '../config/video-room.config';
import { videoRoomMediaRecoveryKey } from '../constants/video-room.constants';
import { DEFAULT_BEAUTY } from '../media/beauty-settings';
import {
  newParticipant,
  toMediaStageView,
  upsertParticipant,
  type MediaParticipant,
  type MediaStageSnapshot,
  type MediaStageView,
} from '../media/media-stage';
import type { MediaSession } from '../media/media-session';
import { MediaTokenService } from '../media/media-token.service';
import {
  MediaFailedEvent,
  MediaRecoveredEvent,
  StreamRecoveredEvent,
  StreamStateChangedEvent,
} from '../events/video-room-media.events';
import { VideoRoomMediaService, type MediaJoinResult } from './video-room-media.service';
import { VideoRoomMediaStateService } from './video-room-media-state.service';
import { VideoRoomMediaSessionRepository } from '../repositories/video-room-media-session.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';

/** Map the ephemeral (Redis/socket) ConnectionType onto the durable Prisma publish-role enum. */
function toPublishRole(role: ConnectionType): VideoRoomPublishRole {
  return role === ConnectionType.PUBLISHER
    ? VideoRoomPublishRole.PUBLISHER
    : VideoRoomPublishRole.SUBSCRIBER;
}

/** Network recovery for media sessions/streams (VR-5). Owns recovery tokens + the RECOVERING lifecycle. */
@Injectable()
export class VideoRoomMediaRecoveryService {
  private readonly cfg: VideoRoomConfig;

  constructor(
    private readonly media: VideoRoomMediaService,
    private readonly mediaState: VideoRoomMediaStateService,
    private readonly mediaSessions: VideoRoomMediaSessionRepository,
    private readonly rooms: VideoRoomsRepository,
    private readonly tokens: MediaTokenService,
    private readonly events: VideoRoomEventsRepository,
    private readonly cache: CacheService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    config: ConfigService,
  ) {
    this.cfg = loadVideoRoomConfig(config);
  }

  async recover(
    actor: RoomActor,
    roomId: string,
    _dto: { lastVersion?: number },
  ): Promise<MediaJoinResult> {
    const room = await this.rooms.findById(roomId);
    if (!room || room.deletedAt || room.status !== 'LIVE') {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MEDIA_RECOVERY_FAILED,
        'Room is not recoverable.',
        HttpStatus.CONFLICT,
      );
    }
    const session = await this.mediaSessions.find(roomId, actor.id);
    if (!session) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MEDIA_RECOVERY_FAILED,
        'No media session to recover.',
        HttpStatus.CONFLICT,
      );
    }
    const canPublish = session.role === 'PUBLISHER';
    const role = canPublish ? ConnectionType.PUBLISHER : ConnectionType.SUBSCRIBER;
    const mediaRoomId = room.zegoRoomId ?? '';
    await this.mediaSessions.start({
      roomId,
      userId: actor.id,
      zegoRoomId: mediaRoomId,
      role: toPublishRole(role),
    });

    // Resolve the cold-restore candidate BEFORE taking the media lock: this hits the DB
    // (findLatestSnapshot) and must not run while the videoRoomMediaLockKey(roomId) lock is
    // held, or a reconnect storm serializes recover() calls across DB latency. The candidate
    // is a pure seed — it's only spliced in below if the participant still turns out to be
    // absent inside the lock; its live fields get overwritten to CONNECTED/LIVE regardless.
    const restoredCandidate = await this.buildRestoreCandidate(roomId, actor.id, role);
    const stage = await this.media.mutateStage(roomId, async (base) => {
      let participants = base.participants;
      if (!participants.some((p) => p.userId === actor.id)) {
        participants = [...participants, restoredCandidate];
      }
      participants = upsertParticipant(participants, actor.id, (p) => ({
        ...p,
        connection: ConnectionStatus.CONNECTED,
        streamState:
          p.streamState === MediaStreamState.RECOVERING || p.streamState === MediaStreamState.FAILED
            ? MediaStreamState.LIVE
            : p.streamState,
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });

    await this.cache.del(videoRoomMediaRecoveryKey(roomId, actor.id));
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'media.recovered',
      payload: { userId: actor.id },
    });
    const me = stage.participants.find((p) => p.userId === actor.id)!;
    await this.bus.publish(
      new MediaRecoveredEvent({ roomId, version: stage.version, userId: actor.id }),
    );
    await this.bus.publish(
      new StreamRecoveredEvent({
        roomId,
        version: stage.version,
        userId: actor.id,
        streamId: me.streamId,
      }),
    );
    const mediaSession: MediaSession = this.tokens.issueForRoom({
      userId: actor.id,
      mediaRoomId,
      canPublish,
    });
    return { mediaSession, stage };
  }

  /** Monitor-driven: a live publisher's heartbeat went stale — enter RECOVERING + arm the grace token. */
  async markRecovering(roomId: string, userId: string): Promise<void> {
    const stage = await this.media.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === userId);
      if (!me || me.streamState !== MediaStreamState.LIVE) return base; // idempotent
      const participants = upsertParticipant(base.participants, userId, (p) => ({
        ...p,
        streamState: MediaStreamState.RECOVERING,
        connection: ConnectionStatus.RECONNECTING,
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.cache.set(
      videoRoomMediaRecoveryKey(roomId, userId),
      { at: new Date().toISOString() },
      this.cfg.mediaRecoveryTokenTtlSeconds,
    );
    await this.bus.publish(
      new StreamStateChangedEvent({
        roomId,
        version: stage.version,
        userId,
        streamState: MediaStreamState.RECOVERING,
      }),
    );
  }

  /** Grace elapsed — end the media session and publish a failure. */
  async expireRecovery(roomId: string, userId: string): Promise<void> {
    const stage = await this.media.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === userId);
      if (!me) return base;
      const participants = upsertParticipant(base.participants, userId, (p) => ({
        ...p,
        streamState: MediaStreamState.ENDED,
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.bus.publish(
      new MediaFailedEvent({ roomId, version: stage.version, userId, reason: 'recovery_timeout' }),
    );
    await this.media.leaveMedia({ id: userId, roles: [] } as RoomActor, roomId);
    await this.cache.del(videoRoomMediaRecoveryKey(roomId, userId));
  }

  /** Client-reported unrecoverable stream error — mark FAILED + arm the grace token. */
  async reportStreamFailure(roomId: string, userId: string, reason: string): Promise<void> {
    const stage = await this.media.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === userId);
      if (!me) return base;
      const participants = upsertParticipant(base.participants, userId, (p) => ({
        ...p,
        streamState: MediaStreamState.FAILED,
        connection: ConnectionStatus.RECONNECTING,
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.cache.set(
      videoRoomMediaRecoveryKey(roomId, userId),
      { at: new Date().toISOString() },
      this.cfg.mediaRecoveryTokenTtlSeconds,
    );
    await this.bus.publish(
      new MediaFailedEvent({ roomId, version: stage.version, userId, reason }),
    );
  }

  /** Rehydrate a whole stage from the latest durable snapshot (cold Redis after a reopen). */
  async restoreFromSnapshot(roomId: string): Promise<MediaStageView | null> {
    const snap = await this.events.findLatestSnapshot(roomId);
    if (!snap) return null;
    const state = snap.state as unknown as MediaStageSnapshot;
    const restored = await this.mediaState.commit(roomId, state, {});
    return toMediaStageView(restored);
  }

  /** Builds the cold-restore seed OUTSIDE the media lock (does the DB read). Pure w.r.t. the lock. */
  private async buildRestoreCandidate(
    roomId: string,
    userId: string,
    role: ConnectionType,
  ): Promise<MediaParticipant> {
    const snap = await this.events.findLatestSnapshot(roomId);
    const prior = snap
      ? (snap.state as unknown as MediaStageSnapshot).participants?.find((p) => p.userId === userId)
      : undefined;
    return (
      prior ??
      newParticipant({
        userId,
        seatIndex: null,
        role,
        nowIso: new Date().toISOString(),
        defaultBeauty: DEFAULT_BEAUTY,
      })
    );
  }
}
