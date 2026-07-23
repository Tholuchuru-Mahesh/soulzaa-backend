import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { VoicePublishRole, VoiceSession, VoiceSessionAction } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import { ZegoTokenService } from 'src/infra/zego/zego-token.service';
import {
  VOICE_HEARTBEAT_TTL_SECONDS,
  VOICE_QUALITY_SAMPLE_EVERY,
  voiceLockKey,
} from '../constants/voice.constants';
import type { VoiceBackgroundDto } from '../dto/voice-background.dto';
import type { VoiceHeartbeatDto } from '../dto/voice-heartbeat.dto';
import type { VoiceJoinDto } from '../dto/voice-join.dto';
import type { VoiceQualityDto } from '../dto/voice-quality.dto';
import type { VoiceRouteDto } from '../dto/voice-route.dto';
import {
  VoiceBackgroundEvent,
  VoiceJoinedEvent,
  VoiceLeftEvent,
  VoiceMutedEvent,
  VoiceQualityEvent,
  VoiceReconnectedEvent,
  VoiceRouteChangedEvent,
  VoiceSpeakingChangedEvent,
  VoiceStateEvent,
  VoiceUnmutedEvent,
} from '../events/audio-room-voice.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
} from '../interfaces/audio-rooms.service.interface';
import type { IVoiceService } from '../interfaces/voice.service.interface';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { ModerationRepository } from '../repositories/moderation.repository';
import {
  VoiceSessionRepository,
  type VoiceStateSnapshot,
} from '../repositories/voice-session.repository';

/** A ZEGO join token plus the voice state the client renders on entry. */
export interface VoiceTokenResult {
  appId: number;
  token: string;
  zegoRoomId: string;
  userId: string;
  role: VoicePublishRole;
  expiresInSeconds: number;
}

export interface VoiceJoinResult extends VoiceTokenResult {
  voiceState: VoiceStateSnapshot;
}

/**
 * AR-2 voice layer: ZEGOCLOUD token issuance + the backend voice-session
 * lifecycle. Every command asserts the room is LIVE and the actor is an active
 * member (via the AR-0/AR-1 public contract); session transitions run under a
 * per-room lock; each appends an immutable voice_session_logs row, refreshes the
 * Redis voice-state snapshot, publishes a domain event (bridged to `voice.*`),
 * and — on session end — enqueues an analytics job. Publish privilege follows
 * seat occupancy: speakers publish, the audience only subscribes (server-side).
 */
@Injectable()
export class VoiceService implements IVoiceService {
  private readonly heartbeatTtl = VOICE_HEARTBEAT_TTL_SECONDS;

  constructor(
    private readonly voice: VoiceSessionRepository,
    private readonly rooms: AudioRoomsRepository,
    private readonly moderation: ModerationRepository,
    private readonly zego: ZegoTokenService,
    private readonly locks: LockService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(AUDIO_ROOMS_SERVICE) private readonly roomsSvc: IAudioRoomsService,
  ) {}

  // ======================= Token =======================

  async issueToken(actor: RoomActor, roomId: string): Promise<VoiceTokenResult> {
    await this.assertVoiceReady(roomId, actor.id);
    const zegoRoomId = await this.ensureZegoRoomId(roomId);
    const canPublish = await this.roomsSvc.isSpeaker(roomId, actor.id);
    return this.buildToken(actor.id, roomId, zegoRoomId, canPublish);
  }

  // ======================= Join / leave / reconnect =======================

  async join(actor: RoomActor, roomId: string, dto: VoiceJoinDto): Promise<VoiceJoinResult> {
    return this.enterVoice(actor, roomId, dto.audioRoute ?? null, false);
  }

  async reconnect(actor: RoomActor, roomId: string): Promise<VoiceJoinResult> {
    return this.enterVoice(actor, roomId, null, true);
  }

  private async enterVoice(
    actor: RoomActor,
    roomId: string,
    audioRoute: string | null,
    isReconnect: boolean,
  ): Promise<VoiceJoinResult> {
    await this.assertVoiceReady(roomId, actor.id);
    const zegoRoomId = await this.ensureZegoRoomId(roomId);
    const canPublish = await this.roomsSvc.isSpeaker(roomId, actor.id);
    const role = canPublish ? VoicePublishRole.PUBLISHER : VoicePublishRole.SUBSCRIBER;

    const { session, wasActive } = await this.locks.withLock(voiceLockKey(roomId), async () => {
      const result = await this.voice.upsertJoin({
        roomId,
        userId: actor.id,
        zegoRoomId,
        role,
        audioRoute,
      });
      await this.voice.addVoicePresence(roomId, actor.id);
      await this.voice.setHeartbeat(roomId, actor.id, this.heartbeatTtl);
      return result;
    });

    const count = await this.voice.voiceCount(roomId);
    if (wasActive || isReconnect) {
      await this.voice.appendVoiceSessionLog({
        roomId,
        userId: actor.id,
        action: isReconnect ? VoiceSessionAction.NETWORK_RECOVERED : VoiceSessionAction.RECONNECTED,
      });
      await this.bus.publish(
        new VoiceReconnectedEvent({
          roomId,
          userId: actor.id,
          reconnectCount: session.reconnectCount,
        }),
      );
    } else {
      await this.voice.appendVoiceSessionLog({
        roomId,
        userId: actor.id,
        action: VoiceSessionAction.JOINED,
      });
      await this.bus.publish(
        new VoiceJoinedEvent({ roomId, userId: actor.id, role, participantCount: count }),
      );
    }

    const token = this.buildToken(actor.id, roomId, zegoRoomId, canPublish);
    const voiceState = await this.rebuildVoiceState(roomId);
    return { ...token, voiceState };
  }

  async leave(actor: RoomActor, roomId: string): Promise<void> {
    const session = await this.voice.getActiveSession(roomId, actor.id);
    if (!session) {
      // Idempotent: clean any stray Redis state and return.
      await this.clearVoiceRuntime(roomId, actor.id);
      return;
    }
    const durationSeconds = (Date.now() - session.joinedAt.getTime()) / 1000;
    await this.voice.endSession(roomId, actor.id, durationSeconds);
    await this.clearVoiceRuntime(roomId, actor.id);
    await this.voice.appendVoiceSessionLog({
      roomId,
      userId: actor.id,
      action: VoiceSessionAction.LEFT,
      metadata: { durationSeconds: Math.floor(durationSeconds) },
    });
    const count = await this.voice.voiceCount(roomId);
    await this.bus.publish(
      new VoiceLeftEvent({
        roomId,
        userId: actor.id,
        durationSeconds: Math.floor(durationSeconds),
        reason: 'left',
        participantCount: count,
      }),
    );
    await this.enqueueSessionAnalytics(roomId, session, Math.floor(durationSeconds));
    await this.rebuildVoiceState(roomId);
  }

  // ======================= Mic / heartbeat / quality =======================

  async setSelfMute(actor: RoomActor, roomId: string, muted: boolean): Promise<VoiceStateSnapshot> {
    const session = await this.requireActiveSession(roomId, actor.id);
    if (!muted) {
      if (await this.moderation.isMutedCached(roomId, actor.id)) {
        throw new BusinessException(
          ERROR_CODES.MEMBER_MUTED,
          'You have been muted by a moderator and cannot unmute yourself.',
          HttpStatus.FORBIDDEN,
        );
      }
      const isRoomMuted = await this.roomsSvc.isRoomMuted(roomId);
      if (isRoomMuted) {
        const room = await this.rooms.findRoomRow(roomId);
        const isOwner = room?.ownerId === actor.id;
        if (!isOwner) {
          throw new BusinessException(
            ERROR_CODES.MEMBER_MUTED,
            'Broad Mute is enabled in this room. You cannot unmute yourself.',
            HttpStatus.FORBIDDEN,
          );
        }
      }
    }
    await this.voice.updateSelfMute(session.id, muted);
    await this.voice.appendVoiceSessionLog({
      roomId,
      userId: actor.id,
      action: muted ? VoiceSessionAction.MUTED : VoiceSessionAction.UNMUTED,
    });
    await this.bus.publish(
      muted
        ? new VoiceMutedEvent({ roomId, userId: actor.id, selfMuted: true })
        : new VoiceUnmutedEvent({ roomId, userId: actor.id, selfMuted: false }),
    );
    return this.rebuildVoiceState(roomId);
  }

  async heartbeat(
    actor: RoomActor,
    roomId: string,
    dto: VoiceHeartbeatDto,
  ): Promise<VoiceStateSnapshot> {
    const session = await this.requireActiveSession(roomId, actor.id);

    const hasQuality = dto.rttMs !== undefined && dto.packetLossPct !== undefined;
    const sample = hasQuality
      ? {
          qualityLevel: dto.networkQualityLevel,
          rttMs: dto.rttMs!,
          packetLossPct: dto.packetLossPct!,
        }
      : undefined;
    await this.voice.recordHeartbeat(session, sample);
    await this.voice.setHeartbeat(roomId, actor.id, this.heartbeatTtl);
    // Sample the quality log every Nth report to keep the audit table small.
    if (sample && session.qualitySampleCount % VOICE_QUALITY_SAMPLE_EVERY === 0) {
      await this.voice.appendVoiceSessionLog({
        roomId,
        userId: actor.id,
        action: VoiceSessionAction.QUALITY_SAMPLED,
        metadata: { ...sample, audioLevel: dto.audioLevel ?? null },
      });
    }

    await this.applySpeaking(roomId, session, dto.isSpeaking);
    if (dto.audioRoute && dto.audioRoute !== session.audioRoute) {
      await this.applyRoute(roomId, session, dto.audioRoute);
    }
    if (dto.inBackground !== undefined && dto.inBackground !== session.inBackground) {
      await this.applyBackground(roomId, session, dto.inBackground);
    }
    return this.rebuildVoiceState(roomId);
  }

  async reportQuality(
    actor: RoomActor,
    roomId: string,
    dto: VoiceQualityDto,
  ): Promise<VoiceStateSnapshot> {
    const session = await this.requireActiveSession(roomId, actor.id);
    await this.voice.updateQualityRolling(session, {
      qualityLevel: dto.qualityLevel,
      rttMs: dto.rttMs,
      packetLossPct: dto.packetLossPct,
    });
    await this.voice.appendVoiceSessionLog({
      roomId,
      userId: actor.id,
      action: VoiceSessionAction.QUALITY_SAMPLED,
      metadata: {
        qualityLevel: dto.qualityLevel,
        rttMs: dto.rttMs,
        packetLossPct: dto.packetLossPct,
        jitterMs: dto.jitterMs ?? null,
      },
    });
    await this.bus.publish(
      new VoiceQualityEvent({
        roomId,
        userId: actor.id,
        qualityLevel: dto.qualityLevel,
        rttMs: dto.rttMs,
        packetLossPct: dto.packetLossPct,
      }),
    );
    await this.queue.enqueue(QUEUE_NAMES.ANALYTICS_PROCESSING, 'voice.quality', {
      roomId,
      userId: actor.id,
      qualityLevel: dto.qualityLevel,
      rttMs: dto.rttMs,
      packetLossPct: dto.packetLossPct,
      jitterMs: dto.jitterMs ?? null,
    });
    return this.rebuildVoiceState(roomId);
  }

  async switchRoute(
    actor: RoomActor,
    roomId: string,
    dto: VoiceRouteDto,
  ): Promise<VoiceStateSnapshot> {
    const session = await this.requireActiveSession(roomId, actor.id);
    if (dto.route !== session.audioRoute) await this.applyRoute(roomId, session, dto.route);
    return this.rebuildVoiceState(roomId);
  }

  async setBackground(
    actor: RoomActor,
    roomId: string,
    dto: VoiceBackgroundDto,
  ): Promise<VoiceStateSnapshot> {
    const session = await this.requireActiveSession(roomId, actor.id);
    if (dto.inBackground !== session.inBackground) {
      await this.applyBackground(roomId, session, dto.inBackground);
    }
    return this.rebuildVoiceState(roomId);
  }

  // ======================= Seat-role sync (from AR-1 seat events) =======================

  /** Re-evaluate publish role after a seat change; emit VoiceState so clients re-token. */
  async syncRoleFromSeat(roomId: string, userId: string): Promise<void> {
    const session = await this.voice.getActiveSession(roomId, userId);
    if (!session) return;
    const canPublish = await this.roomsSvc.isSpeaker(roomId, userId);
    const role = canPublish ? VoicePublishRole.PUBLISHER : VoicePublishRole.SUBSCRIBER;
    if (role === session.role) return;
    await this.voice.updateRole(session.id, role);
    await this.voice.appendVoiceSessionLog({
      roomId,
      userId,
      action: VoiceSessionAction.ROLE_CHANGED,
      metadata: { role },
    });
    await this.bus.publish(new VoiceStateEvent({ roomId, userId, reason: 'role_changed', role }));
    await this.rebuildVoiceState(roomId);
  }

  // ======================= Heartbeat-timeout backstop =======================

  /** End a session that stopped sending heartbeats (network drop). */
  async expireSession(session: VoiceSession): Promise<void> {
    const durationSeconds = (Date.now() - session.joinedAt.getTime()) / 1000;
    await this.voice.endSession(session.roomId, session.userId, durationSeconds);
    await this.clearVoiceRuntime(session.roomId, session.userId);
    await this.voice.appendVoiceSessionLog({
      roomId: session.roomId,
      userId: session.userId,
      action: VoiceSessionAction.HEARTBEAT_TIMEOUT,
    });
    await this.voice.appendVoiceSessionLog({
      roomId: session.roomId,
      userId: session.userId,
      action: VoiceSessionAction.NETWORK_LOST,
    });
    const count = await this.voice.voiceCount(session.roomId);
    await this.bus.publish(
      new VoiceLeftEvent({
        roomId: session.roomId,
        userId: session.userId,
        durationSeconds: Math.floor(durationSeconds),
        reason: 'timeout',
        participantCount: count,
      }),
    );
    await this.enqueueSessionAnalytics(session.roomId, session, Math.floor(durationSeconds));
    await this.rebuildVoiceState(session.roomId);
  }

  // ======================= Moderation enforcement (AR-3) =======================

  /** Moderator-forced mic mute/unmute. No-op if the target isn't on the mic. */
  async forceMute(roomId: string, userId: string, muted: boolean): Promise<void> {
    const session = await this.voice.getActiveSession(roomId, userId);
    if (!session) return;
    await this.voice.updateSelfMute(session.id, muted);
    await this.voice.appendVoiceSessionLog({
      roomId,
      userId,
      action: muted ? VoiceSessionAction.MUTED : VoiceSessionAction.UNMUTED,
      metadata: { forced: true },
    });
    await this.bus.publish(
      muted
        ? new VoiceMutedEvent({ roomId, userId, selfMuted: true })
        : new VoiceUnmutedEvent({ roomId, userId, selfMuted: false }),
    );
    await this.rebuildVoiceState(roomId);
  }

  /** Moderator-forced voice teardown (kick/ban). No-op if not in the channel. */
  async forceLeave(roomId: string, userId: string): Promise<void> {
    const session = await this.voice.getActiveSession(roomId, userId);
    if (!session) {
      await this.clearVoiceRuntime(roomId, userId);
      return;
    }
    const durationSeconds = (Date.now() - session.joinedAt.getTime()) / 1000;
    await this.voice.endSession(roomId, userId, durationSeconds);
    await this.clearVoiceRuntime(roomId, userId);
    await this.voice.appendVoiceSessionLog({
      roomId,
      userId,
      action: VoiceSessionAction.LEFT,
      metadata: { durationSeconds: Math.floor(durationSeconds), forced: true },
    });
    const count = await this.voice.voiceCount(roomId);
    await this.bus.publish(
      new VoiceLeftEvent({
        roomId,
        userId,
        durationSeconds: Math.floor(durationSeconds),
        reason: 'left',
        participantCount: count,
      }),
    );
    await this.enqueueSessionAnalytics(roomId, session, Math.floor(durationSeconds));
    await this.rebuildVoiceState(roomId);
  }

  // ======================= Public contract (IVoiceService) =======================

  isInVoice(roomId: string, userId: string): Promise<boolean> {
    return this.voice.isInVoice(roomId, userId);
  }

  async isSelfMuted(roomId: string, userId: string): Promise<boolean> {
    const session = await this.voice.getActiveSession(roomId, userId);
    return session?.selfMuted ?? false;
  }

  activeSpeakers(roomId: string): Promise<string[]> {
    return this.voice.speakingMembers(roomId);
  }

  getVoiceState(roomId: string): Promise<VoiceStateSnapshot> {
    return this.voice
      .getCachedState(roomId)
      .then((cached) => cached ?? this.rebuildVoiceState(roomId));
  }

  // ======================= Internals =======================

  private buildToken(
    userId: string,
    roomId: string,
    zegoRoomId: string,
    canPublish: boolean,
  ): VoiceTokenResult {
    if (!this.zego.isConfigured()) {
      throw new BusinessException(
        ERROR_CODES.VOICE_NOT_CONFIGURED,
        'Voice service is not configured.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const { appId, token, expiresInSeconds } = this.zego.buildRoomToken(
      userId,
      zegoRoomId,
      canPublish,
    );
    return {
      appId,
      token,
      zegoRoomId,
      userId,
      role: canPublish ? VoicePublishRole.PUBLISHER : VoicePublishRole.SUBSCRIBER,
      expiresInSeconds,
    };
  }

  private async ensureZegoRoomId(roomId: string): Promise<string> {
    const existing = await this.rooms.getZegoRoomId(roomId);
    if (existing) return existing;
    return this.locks.withLock(voiceLockKey(roomId), async () => {
      const recheck = await this.rooms.getZegoRoomId(roomId);
      if (recheck) return recheck;
      const id = randomUUID();
      await this.rooms.setZegoRoomId(roomId, id);
      return id;
    });
  }

  private async applySpeaking(
    roomId: string,
    session: VoiceSession,
    isSpeaking: boolean,
  ): Promise<void> {
    if (isSpeaking === session.isSpeaking) return;
    await this.voice.updateSpeaking(session.id, isSpeaking);
    if (isSpeaking) await this.voice.addSpeaking(roomId, session.userId);
    else await this.voice.removeSpeaking(roomId, session.userId);
    await this.voice.appendVoiceSessionLog({
      roomId,
      userId: session.userId,
      action: isSpeaking
        ? VoiceSessionAction.SPEAKING_STARTED
        : VoiceSessionAction.SPEAKING_STOPPED,
    });
    await this.bus.publish(
      new VoiceSpeakingChangedEvent({ roomId, userId: session.userId, isSpeaking }),
    );
  }

  private async applyRoute(roomId: string, session: VoiceSession, route: string): Promise<void> {
    await this.voice.updateRoute(session.id, route);
    await this.voice.appendVoiceSessionLog({
      roomId,
      userId: session.userId,
      action: VoiceSessionAction.ROUTE_SWITCHED,
      metadata: { route },
    });
    await this.bus.publish(new VoiceRouteChangedEvent({ roomId, userId: session.userId, route }));
  }

  private async applyBackground(
    roomId: string,
    session: VoiceSession,
    inBackground: boolean,
  ): Promise<void> {
    await this.voice.updateBackground(session.id, inBackground);
    await this.voice.appendVoiceSessionLog({
      roomId,
      userId: session.userId,
      action: inBackground
        ? VoiceSessionAction.BACKGROUND_ENTERED
        : VoiceSessionAction.BACKGROUND_EXITED,
    });
    await this.bus.publish(
      new VoiceBackgroundEvent({ roomId, userId: session.userId, inBackground }),
    );
  }

  private async clearVoiceRuntime(roomId: string, userId: string): Promise<void> {
    await this.voice.removeVoicePresence(roomId, userId);
    await this.voice.removeSpeaking(roomId, userId);
    await this.voice.clearHeartbeat(roomId, userId);
  }

  private async rebuildVoiceState(roomId: string): Promise<VoiceStateSnapshot> {
    const [sessions, speaking] = await Promise.all([
      this.voice.listActiveSessions(roomId),
      this.voice.speakingMembers(roomId),
    ]);
    const snapshot: VoiceStateSnapshot = {
      participants: sessions.map((s) => ({
        userId: s.userId,
        role: s.role,
        selfMuted: s.selfMuted,
        isSpeaking: s.isSpeaking,
        inBackground: s.inBackground,
        audioRoute: s.audioRoute,
        lastQualityLevel: s.lastQualityLevel,
      })),
      speaking,
    };
    await this.voice.setCachedState(roomId, snapshot);
    return snapshot;
  }

  private async enqueueSessionAnalytics(
    roomId: string,
    session: VoiceSession,
    durationSeconds: number,
  ): Promise<void> {
    await this.queue.enqueue(QUEUE_NAMES.ANALYTICS_PROCESSING, 'voice.session.ended', {
      roomId,
      userId: session.userId,
      durationSeconds,
      reconnectCount: session.reconnectCount,
      avgRttMs: session.avgRttMs,
      worstRttMs: session.worstRttMs,
      avgPacketLossPct: session.avgPacketLossPct,
      qualitySampleCount: session.qualitySampleCount,
    });
  }

  private async assertVoiceReady(roomId: string, userId: string): Promise<void> {
    if (!(await this.roomsSvc.isRoomLive(roomId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'This room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    await this.roomsSvc.assertMember(roomId, userId);
  }

  private async requireActiveSession(roomId: string, userId: string): Promise<VoiceSession> {
    const session = await this.voice.getActiveSession(roomId, userId);
    if (!session) {
      throw new BusinessException(
        ERROR_CODES.VOICE_NOT_IN_CHANNEL,
        'You are not in the voice channel.',
        HttpStatus.CONFLICT,
      );
    }
    return session;
  }
}
