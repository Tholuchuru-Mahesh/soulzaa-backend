import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  VideoRoomPublishRole,
  VideoRoomStatus,
  type VideoRoom,
  type VideoRoomStreamingStatus,
} from '@prisma/client';
import { LockService } from 'src/infra/redis/lock.service';
import type { RoomActor } from '../interfaces/room-actor.interface';
import {
  AudioOutput,
  CameraFacing,
  ConnectionStatus,
  ConnectionType,
  MediaStreamKind,
  MediaStreamState,
  VideoQualityProfile,
} from '../enums';
import { loadVideoRoomConfig, type VideoRoomConfig } from '../config/video-room.config';
import { videoRoomMediaLockKey } from '../constants/video-room.constants';
import { assertStreamTransition } from '../constants/video-room-stream-lifecycle';
import { DEFAULT_BEAUTY, clampBeauty, type BeautySettings } from '../media/beauty-settings';
import { resolveBitrate, selectQualityProfile } from '../media/media-quality';
import {
  newParticipant,
  toMediaStageView,
  upsertParticipant,
  type MediaStageSnapshot,
  type MediaStageView,
} from '../media/media-stage';
import type { MediaSession } from '../media/media-session';
import { MediaTokenService } from '../media/media-token.service';
import {
  MediaSessionCreatedEvent,
  MediaSessionClosedEvent,
  MediaStreamPublishedEvent,
  MediaStreamStoppedEvent,
  StreamPausedEvent,
  StreamResumedEvent,
  SubscribedEvent,
  UnsubscribedEvent,
  CameraEnabledEvent,
  CameraDisabledEvent,
  MicEnabledEvent,
  MicDisabledEvent,
  AudioOutputChangedEvent,
  QualityChangedEvent,
  BeautyChangedEvent,
} from '../events/video-room-media.events';
import { VideoRoomMediaStateService } from './video-room-media-state.service';
import { VideoRoomSeatStateService } from './video-room-seat-state.service';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { VideoRoomMediaSessionRepository } from '../repositories/video-room-media-session.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';

export interface MediaJoinResult {
  mediaSession: MediaSession;
  stage: MediaStageView;
}

/** Map the ephemeral (Redis/socket) ConnectionType onto the durable Prisma publish-role enum. */
function toPublishRole(role: ConnectionType): VideoRoomPublishRole {
  return role === ConnectionType.PUBLISHER
    ? VideoRoomPublishRole.PUBLISHER
    : VideoRoomPublishRole.SUBSCRIBER;
}

/**
 * VR-5 media engine orchestrator (analog of audio VoiceService). Owns the
 * mutateStage locked pipeline and the media-session lifecycle. Publishing,
 * subscription, and device (camera/mic/output/quality/beauty) verbs extend this
 * same class in Tasks 13–15; recovery lives in VideoRoomMediaRecoveryService.
 */
@Injectable()
export class VideoRoomMediaService {
  protected readonly cfg: VideoRoomConfig;

  constructor(
    protected readonly locks: LockService,
    protected readonly mediaState: VideoRoomMediaStateService,
    protected readonly mediaSessions: VideoRoomMediaSessionRepository,
    protected readonly rooms: VideoRoomsRepository,
    protected readonly permissions: VideoRoomPermissionService,
    protected readonly seatState: VideoRoomSeatStateService,
    protected readonly tokens: MediaTokenService,
    protected readonly events: VideoRoomEventsRepository,
    @Inject(EVENT_BUS) protected readonly bus: IEventBus,
    config: ConfigService,
  ) {
    this.cfg = loadVideoRoomConfig(config);
  }

  /** The locked mutation pipeline: load/rebuild → fn (must commit) → view. */
  async mutateStage(
    roomId: string,
    fn: (base: MediaStageSnapshot) => Promise<MediaStageSnapshot>,
  ): Promise<MediaStageView> {
    const next = await this.locks.withLock(videoRoomMediaLockKey(roomId), async () => {
      const base =
        (await this.mediaState.getSnapshot(roomId)) ?? (await this.mediaState.rebuild(roomId));
      return fn(base);
    });
    return toMediaStageView(next);
  }

  async getMediaState(_actor: RoomActor, roomId: string): Promise<MediaStageView> {
    const snap =
      (await this.mediaState.getSnapshot(roomId)) ?? (await this.mediaState.rebuild(roomId));
    return toMediaStageView(snap);
  }

  async joinMedia(
    actor: RoomActor,
    roomId: string,
    dto: { deviceId?: string; platform?: string; network?: string },
    ip?: string,
  ): Promise<MediaJoinResult> {
    const room = await this.loadLiveRoom(roomId);
    await this.assertMember(room, actor.id);
    const mediaRoomId = await this.ensureMediaRoomId(room, actor.id);
    const seatIndex = await this.resolveSeatIndex(roomId, actor.id);
    // The room owner is the host/broadcaster: authorise publishing even before
    // they take an explicit seat, so their ZEGO token grants publish privilege
    // in production (otherwise the host's own stream is denied and no one sees them).
    const canPublish = seatIndex !== null || actor.id === room.ownerId;
    const role = canPublish ? ConnectionType.PUBLISHER : ConnectionType.SUBSCRIBER;

    await this.mediaSessions.start({
      roomId,
      userId: actor.id,
      zegoRoomId: mediaRoomId,
      role: toPublishRole(role),
      deviceId: dto.deviceId ?? null,
      platform: dto.platform ?? null,
      network: dto.network ?? null,
    });

    const stage = await this.mutateStage(roomId, async (base) => {
      const nowIso = new Date().toISOString();
      const already = base.participants.some((p) => p.userId === actor.id);
      let participants = already
        ? upsertParticipant(base.participants, actor.id, (p) => ({
            ...p,
            seatIndex,
            role,
            connection: ConnectionStatus.CONNECTED,
          }))
        : [
            ...base.participants,
            {
              ...newParticipant({
                userId: actor.id,
                seatIndex,
                role,
                nowIso,
                defaultBeauty: this.defaultBeauty(),
              }),
              connection: ConnectionStatus.CONNECTED,
            },
          ];
      const publishers = participants
        .filter((p) => p.userId !== actor.id && p.streamId !== null)
        .map((p) => p.userId)
        .slice(0, this.cfg.maxSubscriptionsPerUser);
      participants = upsertParticipant(participants, actor.id, (p) => ({
        ...p,
        subscriptions: publishers,
      }));
      return this.mediaState.commit(roomId, base, { participants, mediaRoomId });
    });

    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'media.joined',
      payload: { userId: actor.id, seatIndex, role, ip: ip ?? null },
    });
    await this.bus.publish(
      new MediaSessionCreatedEvent({
        roomId,
        version: stage.version,
        userId: actor.id,
        seatIndex,
        role,
      }),
    );

    const mediaSession = this.tokens.issueForRoom({ userId: actor.id, mediaRoomId, canPublish });
    return { mediaSession, stage };
  }

  async leaveMedia(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> {
    const existing = await this.mediaSessions.find(roomId, actor.id);
    const stage = await this.mutateStage(roomId, async (base) => {
      if (!base.participants.some((p) => p.userId === actor.id)) return base; // idempotent
      const participants = base.participants.filter((p) => p.userId !== actor.id);
      return this.mediaState.commit(roomId, base, { participants });
    });
    if (existing) {
      const durationSeconds = BigInt(
        Math.max(0, Math.floor((Date.now() - new Date(existing.joinedAt).getTime()) / 1000)),
      );
      await this.mediaSessions.end(roomId, actor.id, durationSeconds);
      await this.events.appendEvent({
        roomId,
        actorId: actor.id,
        eventType: 'media.left',
        payload: { userId: actor.id, durationSeconds: Number(durationSeconds), ip: ip ?? null },
      });
      await this.bus.publish(
        new MediaSessionClosedEvent({
          roomId,
          version: stage.version,
          userId: actor.id,
          durationSeconds: Number(durationSeconds),
        }),
      );
    }
    return stage;
  }

  async refreshToken(actor: RoomActor, roomId: string): Promise<MediaSession> {
    const room = await this.loadLiveRoom(roomId);
    const session = await this.mediaSessions.find(roomId, actor.id);
    if (!session || session.status !== 'ACTIVE') {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MEDIA_SESSION_INVALID,
        'No active media session to refresh.',
        HttpStatus.CONFLICT,
      );
    }
    const canPublish = session.role === 'PUBLISHER';
    return this.tokens.refresh({
      userId: actor.id,
      mediaRoomId: room.zegoRoomId ?? '',
      role: canPublish ? ConnectionType.PUBLISHER : ConnectionType.SUBSCRIBER,
    });
  }

  async startPublish(
    actor: RoomActor,
    roomId: string,
    dto: { streamKind?: MediaStreamKind },
    ip?: string,
  ): Promise<MediaStageView> {
    await this.loadLiveRoom(roomId);
    const seatIndex = await this.resolveSeatIndex(roomId, actor.id);
    if (seatIndex === null) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MEDIA_SEAT_REQUIRED,
        'Occupy a seat to publish.',
        HttpStatus.FORBIDDEN,
      );
    }
    if ((dto.streamKind ?? MediaStreamKind.CAMERA) === MediaStreamKind.SCREEN) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_STREAM_PUBLISH_FAILED,
        'Screen streams are not yet supported.',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    const streamId = `${roomId}_${actor.id}_camera`;
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_MEDIA_SESSION_INVALID,
          'Join media before publishing.',
          HttpStatus.CONFLICT,
        );
      }
      if (
        me.streamId !== null &&
        (me.streamState === MediaStreamState.LIVE ||
          me.streamState === MediaStreamState.CONNECTING ||
          me.streamState === MediaStreamState.PAUSED)
      ) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_DUPLICATE_STREAM,
          'Already publishing.',
          HttpStatus.CONFLICT,
        );
      }
      assertStreamTransition(me.streamState, MediaStreamState.CONNECTING);
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p,
        seatIndex,
        role: ConnectionType.PUBLISHER,
        streamId,
        streamState: MediaStreamState.LIVE,
        camera: { ...p.camera, on: true },
        mic: { ...p.mic, on: true },
      }));
      const next = await this.mediaState.commit(roomId, base, { participants });
      await this.reconcileRoomStreaming(roomId, next.participants, actor.id);
      return next;
    });
    await this.mediaSessions.setRole(roomId, actor.id, VideoRoomPublishRole.PUBLISHER);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'media.publish',
      payload: { userId: actor.id, seatIndex, streamId, ip: ip ?? null },
    });
    await this.bus.publish(
      new MediaStreamPublishedEvent({
        roomId,
        version: stage.version,
        userId: actor.id,
        streamId,
        streamState: MediaStreamState.LIVE,
      }),
    );
    return stage;
  }

  async stopPublish(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> {
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me || me.streamId === null) return base; // idempotent
      assertStreamTransition(me.streamState, MediaStreamState.STOPPED);
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p,
        streamState: MediaStreamState.STOPPED,
        streamId: null,
        camera: { ...p.camera, on: false },
        mic: { ...p.mic, on: false },
      }));
      const next = await this.mediaState.commit(roomId, base, { participants });
      await this.reconcileRoomStreaming(roomId, next.participants, actor.id);
      return next;
    });
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'media.stop',
      payload: { userId: actor.id, ip: ip ?? null },
    });
    await this.bus.publish(
      new MediaStreamStoppedEvent({
        roomId,
        version: stage.version,
        userId: actor.id,
        streamId: null,
      }),
    );
    return stage;
  }

  /**
   * Force a specific user off publishing back to audience subscriber (VR-6 demote
   * gap-fill). Mirrors stopPublish for an arbitrary target and flips the media
   * session role, so a demoted participant actually stops publishing and the
   * client re-fetches a subscriber token. Idempotent — no-op if not publishing.
   */
  async demoteToSubscriber(roomId: string, userId: string, actorId: string): Promise<void> {
    let changed = false;
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === userId);
      if (!me || (me.role === ConnectionType.SUBSCRIBER && me.streamId === null)) return base; // idempotent
      changed = true;
      const participants = upsertParticipant(base.participants, userId, (p) => ({
        ...p,
        role: ConnectionType.SUBSCRIBER,
        seatIndex: null,
        streamState: MediaStreamState.STOPPED,
        streamId: null,
        camera: { ...p.camera, on: false },
        mic: { ...p.mic, on: false },
      }));
      const next = await this.mediaState.commit(roomId, base, { participants });
      await this.reconcileRoomStreaming(roomId, next.participants, actorId);
      return next;
    });
    if (!changed) return;
    await this.mediaSessions.setRole(roomId, userId, VideoRoomPublishRole.SUBSCRIBER);
    await this.events.appendEvent({
      roomId,
      actorId,
      eventType: 'media.demoted',
      payload: { userId },
    });
    await this.bus.publish(
      new MediaStreamStoppedEvent({ roomId, version: stage.version, userId, streamId: null }),
    );
  }

  async pausePublish(actor: RoomActor, roomId: string): Promise<MediaStageView> {
    const stage = await this.transitionStream(roomId, actor.id, MediaStreamState.PAUSED);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'media.pause',
      payload: { userId: actor.id },
    });
    await this.bus.publish(
      new StreamPausedEvent({ roomId, version: stage.version, userId: actor.id }),
    );
    return stage;
  }

  async resumePublish(actor: RoomActor, roomId: string): Promise<MediaStageView> {
    const stage = await this.transitionStream(roomId, actor.id, MediaStreamState.LIVE);
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'media.resume',
      payload: { userId: actor.id },
    });
    await this.bus.publish(
      new StreamResumedEvent({ roomId, version: stage.version, userId: actor.id }),
    );
    return stage;
  }

  /** Validate + apply a single stream-state transition for a participant. */
  protected async transitionStream(
    roomId: string,
    userId: string,
    to: MediaStreamState,
  ): Promise<MediaStageView> {
    return this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === userId);
      if (!me) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_MEDIA_SESSION_INVALID,
          'No media session.',
          HttpStatus.CONFLICT,
        );
      }
      assertStreamTransition(me.streamState, to);
      const participants = upsertParticipant(base.participants, userId, (p) => ({
        ...p,
        streamState: to,
      }));
      const next = await this.mediaState.commit(roomId, base, { participants });
      await this.reconcileRoomStreaming(roomId, next.participants, userId);
      return next;
    });
  }

  /** Project the room-level streamingStatus from the live participants. */
  protected async reconcileRoomStreaming(
    roomId: string,
    participants: MediaStageView['participants'],
    actorId: string,
  ): Promise<void> {
    const anyLive = participants.some((p) => p.streamState === MediaStreamState.LIVE);
    const anyPaused = participants.some((p) => p.streamState === MediaStreamState.PAUSED);
    const status: VideoRoomStreamingStatus = anyLive ? 'PUBLISHING' : anyPaused ? 'PAUSED' : 'IDLE';
    await this.rooms.setStreamingStatus(roomId, status, actorId);
  }

  async subscribe(
    actor: RoomActor,
    roomId: string,
    dto: { targetUserId: string; priority?: number },
    ip?: string,
  ): Promise<MediaStageView> {
    await this.loadLiveRoom(roomId);
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_MEDIA_SESSION_INVALID,
          'Join media before subscribing.',
          HttpStatus.CONFLICT,
        );
      }
      if (me.subscriptions.includes(dto.targetUserId)) return base; // idempotent
      const target = base.participants.find((p) => p.userId === dto.targetUserId);
      if (!target || target.streamId === null) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_STREAM_SUBSCRIBE_FAILED,
          'Target is not publishing.',
          HttpStatus.CONFLICT,
        );
      }
      if (me.subscriptions.length >= this.cfg.maxSubscriptionsPerUser) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_SUBSCRIPTION_LIMIT,
          'Subscription limit reached.',
          HttpStatus.CONFLICT,
        );
      }
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p,
        subscriptions: [...p.subscriptions, dto.targetUserId],
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'media.subscribe',
      payload: { userId: actor.id, targetUserId: dto.targetUserId, ip: ip ?? null },
    });
    await this.bus.publish(
      new SubscribedEvent({
        roomId,
        version: stage.version,
        userId: actor.id,
        targetUserId: dto.targetUserId,
      }),
    );
    return stage;
  }

  async unsubscribe(
    actor: RoomActor,
    roomId: string,
    dto: { targetUserId: string },
    ip?: string,
  ): Promise<MediaStageView> {
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me || !me.subscriptions.includes(dto.targetUserId)) return base; // idempotent
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p,
        subscriptions: p.subscriptions.filter((id) => id !== dto.targetUserId),
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'media.unsubscribe',
      payload: { userId: actor.id, targetUserId: dto.targetUserId, ip: ip ?? null },
    });
    await this.bus.publish(
      new UnsubscribedEvent({
        roomId,
        version: stage.version,
        userId: actor.id,
        targetUserId: dto.targetUserId,
      }),
    );
    return stage;
  }

  // ---- device controls (VR-5 Task 15) ----

  async cameraOn(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> {
    return this.setCamera(actor, roomId, true, ip);
  }

  async cameraOff(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> {
    return this.setCamera(actor, roomId, false, ip);
  }

  private async setCamera(
    actor: RoomActor,
    roomId: string,
    on: boolean,
    ip?: string,
  ): Promise<MediaStageView> {
    await this.assertSeated(roomId, actor.id);
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_CAMERA_ERROR,
          'Join media first.',
          HttpStatus.CONFLICT,
        );
      }
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p,
        camera: { ...p.camera, on },
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.mediaSessions.setSelfMedia(roomId, actor.id, { selfMutedVideo: !on });
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: on ? 'media.camera_on' : 'media.camera_off',
      payload: { userId: actor.id, ip: ip ?? null },
    });
    await this.bus.publish(
      on
        ? new CameraEnabledEvent({ roomId, version: stage.version, userId: actor.id })
        : new CameraDisabledEvent({ roomId, version: stage.version, userId: actor.id }),
    );
    return stage;
  }

  async switchCamera(
    actor: RoomActor,
    roomId: string,
    dto: { facing: CameraFacing },
    ip?: string,
  ): Promise<MediaStageView> {
    await this.assertSeated(roomId, actor.id);
    await this.assertMediaAllowed(
      roomId,
      'allowCameraSwitch',
      'Camera switching is disabled in this room.',
    );
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_CAMERA_ERROR,
          'Join media first.',
          HttpStatus.CONFLICT,
        );
      }
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p,
        camera: { ...p.camera, facing: dto.facing },
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.mediaSessions.setSelfMedia(roomId, actor.id, { cameraFacing: dto.facing });
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'media.camera_switch',
      payload: { userId: actor.id, facing: dto.facing, ip: ip ?? null },
    });
    await this.bus.publish(
      new CameraEnabledEvent({ roomId, version: stage.version, userId: actor.id }),
    );
    return stage;
  }

  async micOn(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> {
    return this.setSelfMute(actor, roomId, false, ip);
  }

  async micOff(actor: RoomActor, roomId: string, ip?: string): Promise<MediaStageView> {
    return this.setSelfMute(actor, roomId, true, ip);
  }

  async setSelfMute(
    actor: RoomActor,
    roomId: string,
    muted: boolean,
    ip?: string,
  ): Promise<MediaStageView> {
    await this.assertSeated(roomId, actor.id);
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      if (!me) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_MICROPHONE_ERROR,
          'Join media first.',
          HttpStatus.CONFLICT,
        );
      }
      if (!muted && me.mic.adminMuted) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_MICROPHONE_ERROR,
          'You have been muted by a moderator.',
          HttpStatus.FORBIDDEN,
        );
      }
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p,
        mic: { ...p.mic, on: !muted, selfMuted: muted },
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.mediaSessions.setSelfMedia(roomId, actor.id, { selfMutedAudio: muted });
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: muted ? 'media.mic_off' : 'media.mic_on',
      payload: { userId: actor.id, ip: ip ?? null },
    });
    await this.bus.publish(
      muted
        ? new MicDisabledEvent({ roomId, version: stage.version, userId: actor.id, byAdmin: false })
        : new MicEnabledEvent({ roomId, version: stage.version, userId: actor.id }),
    );
    return stage;
  }

  async forceMute(
    actor: RoomActor,
    roomId: string,
    dto: { targetUserId: string; muted: boolean },
    ip?: string,
  ): Promise<MediaStageView> {
    const room = await this.loadLiveRoom(roomId);
    const ref = { id: room.id, ownerId: room.ownerId };
    await this.permissions.assertPermission(actor, ref, VideoRoomPermission.MANAGE_PARTICIPANTS);
    await this.permissions.assertOutranks(ref, actor.id, dto.targetUserId);
    const stage = await this.mutateStage(roomId, async (base) => {
      const target = base.participants.find((p) => p.userId === dto.targetUserId);
      if (!target) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_MICROPHONE_ERROR,
          'Target has no media session.',
          HttpStatus.NOT_FOUND,
        );
      }
      const participants = upsertParticipant(base.participants, dto.targetUserId, (p) => ({
        ...p,
        mic: { ...p.mic, adminMuted: dto.muted, on: dto.muted ? false : p.mic.on },
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.mediaSessions.setSelfMedia(roomId, dto.targetUserId, { selfMutedAudio: dto.muted });
    await this.events.appendEvent({
      roomId,
      actorId: actor.id,
      eventType: 'media.force_mute',
      payload: {
        actorId: actor.id,
        targetUserId: dto.targetUserId,
        muted: dto.muted,
        ip: ip ?? null,
      },
    });
    await this.bus.publish(
      dto.muted
        ? new MicDisabledEvent({
            roomId,
            version: stage.version,
            userId: dto.targetUserId,
            byAdmin: true,
          })
        : new MicEnabledEvent({ roomId, version: stage.version, userId: dto.targetUserId }),
    );
    return stage;
  }

  async setAudioOutput(
    actor: RoomActor,
    roomId: string,
    dto: { output: AudioOutput },
  ): Promise<MediaStageView> {
    const stage = await this.mutateStage(roomId, async (base) => {
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p,
        audioOutput: dto.output,
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.bus.publish(
      new AudioOutputChangedEvent({
        roomId,
        version: stage.version,
        userId: actor.id,
        output: dto.output,
      }),
    );
    return stage;
  }

  async setQuality(
    actor: RoomActor,
    roomId: string,
    dto: { profile: VideoQualityProfile },
  ): Promise<MediaStageView> {
    const bitrateKbps = resolveBitrate(dto.profile, this.cfg.maxBitrateKbps);
    const stage = await this.mutateStage(roomId, async (base) => {
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p,
        quality: dto.profile,
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    await this.bus.publish(
      new QualityChangedEvent({
        roomId,
        version: stage.version,
        userId: actor.id,
        profile: dto.profile,
        bitrateKbps,
      }),
    );
    return stage;
  }

  async setBeauty(
    actor: RoomActor,
    roomId: string,
    dto: Partial<BeautySettings>,
  ): Promise<MediaStageView> {
    await this.assertMediaAllowed(
      roomId,
      'allowBeauty',
      'Beauty filters are disabled in this room.',
    );
    const stage = await this.mutateStage(roomId, async (base) => {
      const me = base.participants.find((p) => p.userId === actor.id);
      const beauty = clampBeauty(dto, me?.beauty);
      const participants = upsertParticipant(base.participants, actor.id, (p) => ({
        ...p,
        beauty,
      }));
      return this.mediaState.commit(roomId, base, { participants });
    });
    const applied = stage.participants.find((p) => p.userId === actor.id)!.beauty;
    await this.bus.publish(
      new BeautyChangedEvent({
        roomId,
        version: stage.version,
        userId: actor.id,
        enabled: applied.enabled,
        level: applied.level,
      }),
    );
    return stage;
  }

  async heartbeat(
    actor: RoomActor,
    roomId: string,
    dto: {
      rttMs?: number;
      packetLossPct?: number;
      bitrateKbps?: number;
      frameRate?: number;
      qualityLevel?: number;
    },
  ): Promise<void> {
    const session = await this.mediaSessions.find(roomId, actor.id);
    if (!session) return;
    await this.mediaSessions.recordQuality(roomId, actor.id, {
      lastHeartbeatAt: new Date(),
      qualitySampleCount: { increment: 1 },
      ...(dto.qualityLevel != null ? { lastQualityLevel: dto.qualityLevel } : {}),
      ...(dto.rttMs != null ? { avgRttMs: Math.round(dto.rttMs) } : {}),
      ...(dto.frameRate != null ? { avgFrameRate: Math.round(dto.frameRate) } : {}),
      ...(dto.bitrateKbps != null ? { avgBitrateKbps: Math.round(dto.bitrateKbps) } : {}),
    });
    const snap = await this.mediaState.getSnapshot(roomId);
    const me = snap?.participants.find((p) => p.userId === actor.id);
    // Assess adaptive quality immediately on the first sample (count 0), then throttle to
    // every Nth heartbeat. Uses the pre-increment count (read via find(), before
    // recordQuality's increment lands) deliberately.
    if (
      me?.quality === VideoQualityProfile.ADAPTIVE &&
      session.qualitySampleCount % this.cfg.qualitySampleEvery === 0
    ) {
      const profile = selectQualityProfile({
        rttMs: dto.rttMs,
        packetLossPct: dto.packetLossPct,
        bitrateKbps: dto.bitrateKbps,
      });
      const bitrateKbps = resolveBitrate(profile, this.cfg.maxBitrateKbps);
      await this.bus.publish(
        new QualityChangedEvent({
          roomId,
          version: snap!.version,
          userId: actor.id,
          profile,
          bitrateKbps,
        }),
      );
    }
  }

  /**
   * VR-17 room-policy gate for media capabilities. These flags were write-only
   * columns until this phase; without this check the corresponding settings
   * toggles would be placeholders.
   */
  private async assertMediaAllowed(
    roomId: string,
    flag: 'allowBeauty' | 'allowCameraSwitch',
    message: string,
  ): Promise<void> {
    const settings = await this.rooms.requireSettings(roomId);
    if (!settings[flag]) {
      throw new BusinessException(ERROR_CODES.VIDEO_ROOM_FORBIDDEN, message, HttpStatus.FORBIDDEN);
    }
  }

  /** Publish/camera/mic require an active seat. */
  protected async assertSeated(roomId: string, userId: string): Promise<void> {
    if ((await this.resolveSeatIndex(roomId, userId)) === null) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MEDIA_SEAT_REQUIRED,
        'Occupy a seat to use media.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  // ---- protected helpers (reused by Tasks 13–15 + recovery) ----

  protected async loadLiveRoom(roomId: string): Promise<VideoRoom> {
    const room = await this.rooms.findById(roomId);
    if (!room || room.deletedAt) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (room.status !== VideoRoomStatus.LIVE) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
        'Room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    return room;
  }

  protected async assertMember(room: VideoRoom, userId: string): Promise<void> {
    const role = await this.permissions.resolveEffectiveRole(
      { id: room.id, ownerId: room.ownerId },
      userId,
    );
    if (role === null) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'You are not a member of this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** The seat index a user occupies, or null (audience). Reads the VR-4 seat snapshot. */
  protected async resolveSeatIndex(roomId: string, userId: string): Promise<number | null> {
    const seatSnap =
      (await this.seatState.getSnapshot(roomId)) ?? (await this.seatState.rebuild(roomId));
    const seat = seatSnap.seats.find((s) => s.occupantUserId === userId);
    return seat ? seat.seatIndex : null;
  }

  /** Read (or lazily mint) the room's ZEGO handle. Sequential — never nested inside mutateStage's lock. */
  protected async ensureMediaRoomId(room: VideoRoom, actorId: string): Promise<string> {
    if (room.zegoRoomId) return room.zegoRoomId;
    if (!this.tokens.isConfigured()) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MEDIA_NOT_CONFIGURED,
        'The media provider is not configured.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.locks.withLock(videoRoomMediaLockKey(room.id), async () => {
      const fresh = await this.rooms.findById(room.id);
      if (fresh?.zegoRoomId) return fresh.zegoRoomId;
      const mediaRoomId = this.tokens.mintMediaRoomId();
      await this.rooms.setZegoRoomId(room.id, mediaRoomId, actorId);
      return mediaRoomId;
    });
  }

  protected defaultBeauty(): BeautySettings {
    const level = this.cfg.defaultBeautyLevel;
    return { ...DEFAULT_BEAUTY, enabled: level > 0, level };
  }
}
