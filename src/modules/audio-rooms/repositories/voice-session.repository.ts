import { Inject, Injectable } from '@nestjs/common';
import { Prisma, VoicePublishRole, VoiceSession, VoiceSessionAction } from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { CacheService } from 'src/infra/redis/cache.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import {
  VOICE_STATE_TTL_SECONDS,
  voiceHeartbeatKey,
  voicePresenceKey,
  voiceSpeakingKey,
  voiceStateCacheKey,
} from '../constants/voice.constants';

/** A cached snapshot of a room's live voice state. */
export interface VoiceStateSnapshot {
  participants: Array<{
    userId: string;
    role: VoicePublishRole;
    selfMuted: boolean;
    isSpeaking: boolean;
    inBackground: boolean;
    audioRoute: string | null;
    lastQualityLevel: number | null;
  }>;
  speaking: string[];
}

/** A single client-reported quality sample, folded into the rolling summary. */
export interface QualitySample {
  qualityLevel: number;
  rttMs: number;
  packetLossPct: number;
}

/**
 * Data layer for AR-2 voice: Postgres (voice_sessions durable records + rolling
 * quality summary, append-only voice_session_logs) plus Redis (voice presence
 * set, speaking set, per-user heartbeat TTL keys, and the voice-state snapshot
 * cache). The DB is authoritative for durable session facts; Redis is the hot
 * live view. Single-key Redis ops → Cluster-safe.
 */
@Injectable()
export class VoiceSessionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  // ---- voice_sessions ----

  findSession(roomId: string, userId: string): Promise<VoiceSession | null> {
    return this.prisma.voiceSession.findUnique({ where: { roomId_userId: { roomId, userId } } });
  }

  getActiveSession(roomId: string, userId: string): Promise<VoiceSession | null> {
    return this.prisma.voiceSession.findFirst({
      where: { roomId, userId, status: 'ACTIVE' },
    });
  }

  /** Insert or reactivate a session for a (re)join. Returns the row + prior state. */
  async upsertJoin(input: {
    roomId: string;
    userId: string;
    zegoRoomId: string;
    role: VoicePublishRole;
    audioRoute: string | null;
  }): Promise<{ session: VoiceSession; wasActive: boolean }> {
    const existing = await this.findSession(input.roomId, input.userId);
    const wasActive = existing?.status === 'ACTIVE';
    const session = await this.prisma.voiceSession.upsert({
      where: { roomId_userId: { roomId: input.roomId, userId: input.userId } },
      create: {
        roomId: input.roomId,
        userId: input.userId,
        zegoRoomId: input.zegoRoomId,
        role: input.role,
        audioRoute: input.audioRoute,
        ...auditCreate(input.userId),
      },
      update: wasActive
        ? // Already live → this is a reconnect.
          {
            role: input.role,
            reconnectCount: { increment: 1 },
            lastHeartbeatAt: new Date(),
            ...auditUpdate(input.userId),
          }
        : // Prior session had ended → fresh join, reset live state.
          {
            status: 'ACTIVE',
            role: input.role,
            selfMuted: false,
            isSpeaking: false,
            inBackground: false,
            audioRoute: input.audioRoute,
            joinedAt: new Date(),
            endedAt: null,
            lastHeartbeatAt: new Date(),
            ...auditUpdate(input.userId),
          },
    });
    return { session, wasActive };
  }

  async endSession(roomId: string, userId: string, durationSeconds: number): Promise<void> {
    await this.prisma.voiceSession.updateMany({
      where: { roomId, userId, status: 'ACTIVE' },
      data: {
        status: 'ENDED',
        endedAt: new Date(),
        isSpeaking: false,
        durationSeconds: BigInt(Math.max(0, Math.floor(durationSeconds))),
      },
    });
  }

  /**
   * One DB write per heartbeat: refresh `lastHeartbeatAt` and, when a quality
   * sample is supplied, fold it into the rolling summary in the same update.
   */
  async recordHeartbeat(session: VoiceSession, quality?: QualitySample): Promise<void> {
    const data: Prisma.VoiceSessionUpdateInput = { lastHeartbeatAt: new Date() };
    if (quality) {
      const n = session.qualitySampleCount;
      data.lastQualityLevel = quality.qualityLevel;
      data.avgRttMs = Math.round(((session.avgRttMs ?? 0) * n + quality.rttMs) / (n + 1));
      data.avgPacketLossPct =
        ((session.avgPacketLossPct ?? 0) * n + quality.packetLossPct) / (n + 1);
      data.worstRttMs = Math.max(session.worstRttMs ?? 0, quality.rttMs);
      data.qualitySampleCount = { increment: 1 };
      data.lastReportAt = new Date();
    }
    await this.prisma.voiceSession.update({ where: { id: session.id }, data });
  }

  async updateSelfMute(id: string, selfMuted: boolean): Promise<void> {
    await this.prisma.voiceSession.update({ where: { id }, data: { selfMuted } });
  }

  async updateSpeaking(id: string, isSpeaking: boolean): Promise<void> {
    await this.prisma.voiceSession.update({ where: { id }, data: { isSpeaking } });
  }

  async updateRoute(id: string, audioRoute: string): Promise<void> {
    await this.prisma.voiceSession.update({ where: { id }, data: { audioRoute } });
  }

  async updateBackground(id: string, inBackground: boolean): Promise<void> {
    await this.prisma.voiceSession.update({ where: { id }, data: { inBackground } });
  }

  async updateRole(id: string, role: VoicePublishRole): Promise<void> {
    await this.prisma.voiceSession.update({ where: { id }, data: { role } });
  }

  /** Fold a quality sample into the session's rolling summary (avg/worst/last). */
  async updateQualityRolling(session: VoiceSession, sample: QualitySample): Promise<void> {
    const n = session.qualitySampleCount;
    const avgRtt = Math.round(((session.avgRttMs ?? 0) * n + sample.rttMs) / (n + 1));
    const avgLoss = ((session.avgPacketLossPct ?? 0) * n + sample.packetLossPct) / (n + 1);
    const worst = Math.max(session.worstRttMs ?? 0, sample.rttMs);
    await this.prisma.voiceSession.update({
      where: { id: session.id },
      data: {
        lastQualityLevel: sample.qualityLevel,
        avgRttMs: avgRtt,
        avgPacketLossPct: avgLoss,
        worstRttMs: worst,
        qualitySampleCount: { increment: 1 },
        lastReportAt: new Date(),
      },
    });
  }

  listActiveSessions(roomId: string): Promise<VoiceSession[]> {
    return this.prisma.voiceSession.findMany({
      where: { roomId, status: 'ACTIVE' },
      orderBy: { joinedAt: 'asc' },
    });
  }

  findStaleSessions(olderThan: Date, limit = 200): Promise<VoiceSession[]> {
    return this.prisma.voiceSession.findMany({
      where: { status: 'ACTIVE', lastHeartbeatAt: { lt: olderThan } },
      take: limit,
      orderBy: { lastHeartbeatAt: 'asc' },
    });
  }

  // ---- voice_session_logs (append-only) ----

  async appendVoiceSessionLog(input: {
    roomId: string;
    userId: string;
    action: VoiceSessionAction;
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.prisma.voiceSessionLog.create({
      data: {
        roomId: input.roomId,
        userId: input.userId,
        action: input.action,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
  }

  // ---- Redis voice presence / speaking / heartbeat ----

  async addVoicePresence(roomId: string, userId: string): Promise<void> {
    await this.redis.sadd(voicePresenceKey(roomId), userId);
  }

  async removeVoicePresence(roomId: string, userId: string): Promise<void> {
    await this.redis.srem(voicePresenceKey(roomId), userId);
  }

  voiceParticipants(roomId: string): Promise<string[]> {
    return this.redis.smembers(voicePresenceKey(roomId));
  }

  voiceCount(roomId: string): Promise<number> {
    return this.redis.scard(voicePresenceKey(roomId));
  }

  isInVoice(roomId: string, userId: string): Promise<boolean> {
    return this.redis.sismember(voicePresenceKey(roomId), userId).then((r) => r === 1);
  }

  async setHeartbeat(roomId: string, userId: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(voiceHeartbeatKey(roomId, userId), '1', 'EX', ttlSeconds);
  }

  async clearHeartbeat(roomId: string, userId: string): Promise<void> {
    await this.redis.del(voiceHeartbeatKey(roomId, userId));
  }

  async addSpeaking(roomId: string, userId: string): Promise<void> {
    await this.redis.sadd(voiceSpeakingKey(roomId), userId);
  }

  async removeSpeaking(roomId: string, userId: string): Promise<void> {
    await this.redis.srem(voiceSpeakingKey(roomId), userId);
  }

  speakingMembers(roomId: string): Promise<string[]> {
    return this.redis.smembers(voiceSpeakingKey(roomId));
  }

  // ---- Voice-state snapshot cache ----

  getCachedState(roomId: string): Promise<VoiceStateSnapshot | null> {
    return this.cache.get<VoiceStateSnapshot>(voiceStateCacheKey(roomId));
  }

  async setCachedState(roomId: string, snapshot: VoiceStateSnapshot): Promise<void> {
    await this.cache.set(voiceStateCacheKey(roomId), snapshot, VOICE_STATE_TTL_SECONDS);
  }

  async invalidateState(roomId: string): Promise<void> {
    await this.cache.del(voiceStateCacheKey(roomId));
  }
}
