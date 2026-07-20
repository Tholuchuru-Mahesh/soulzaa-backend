import { Injectable } from '@nestjs/common';
import {
  Prisma,
  VideoRoomPublishRole,
  VideoRoomSession,
  VideoRoomSessionStatus,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Start (or reactivate) a user's durable media session in a room. */
export interface StartSessionInput {
  roomId: string;
  userId: string;
  zegoRoomId: string;
  role?: VideoRoomPublishRole;
  deviceId?: string | null;
  platform?: string | null;
  network?: string | null;
}

/**
 * Persistence for `video_room_sessions` — the durable per-user media (RTC)
 * session, the video analog of the audio VoiceSession. One row per (room,user),
 * reactivated on rejoin. Live presence/heartbeat is authoritative in Redis; this
 * carries the durable record + a rolling A/V quality summary. Pure persistence —
 * no streaming/reconnect orchestration (that lands with the media phase).
 */
@Injectable()
export class VideoRoomMediaSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Start a session, or reactivate the existing one for a rejoining user. */
  async start(input: StartSessionInput): Promise<VideoRoomSession> {
    const now = new Date();
    return this.prisma.videoRoomSession.upsert({
      where: { roomId_userId: { roomId: input.roomId, userId: input.userId } },
      create: {
        roomId: input.roomId,
        userId: input.userId,
        zegoRoomId: input.zegoRoomId,
        role: input.role ?? VideoRoomPublishRole.SUBSCRIBER,
        deviceId: input.deviceId ?? null,
        platform: input.platform ?? null,
        network: input.network ?? null,
        ...auditCreate(input.userId),
      },
      update: {
        status: VideoRoomSessionStatus.ACTIVE,
        zegoRoomId: input.zegoRoomId,
        role: input.role ?? VideoRoomPublishRole.SUBSCRIBER,
        deviceId: input.deviceId ?? null,
        platform: input.platform ?? null,
        network: input.network ?? null,
        endedAt: null,
        joinedAt: now,
        lastHeartbeatAt: now,
        reconnectCount: { increment: 1 },
        ...auditUpdate(input.userId),
      },
    });
  }

  /** A user's session in a room, or null. */
  async find(roomId: string, userId: string): Promise<VideoRoomSession | null> {
    return this.prisma.videoRoomSession.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
  }

  /** Active sessions in a room. */
  async listActive(roomId: string): Promise<VideoRoomSession[]> {
    return this.prisma.videoRoomSession.findMany({
      where: { roomId, status: VideoRoomSessionStatus.ACTIVE },
      orderBy: { joinedAt: 'asc' },
    });
  }

  /** Switch a session's publish role (seat ↔ audience). */
  async setRole(
    roomId: string,
    userId: string,
    role: VideoRoomPublishRole,
  ): Promise<VideoRoomSession> {
    return this.prisma.videoRoomSession.update({
      where: { roomId_userId: { roomId, userId } },
      data: { role, ...auditUpdate(userId) },
    });
  }

  /** Fold a quality sample into the rolling summary. */
  async recordQuality(
    roomId: string,
    userId: string,
    data: Prisma.VideoRoomSessionUpdateInput,
  ): Promise<VideoRoomSession> {
    return this.prisma.videoRoomSession.update({
      where: { roomId_userId: { roomId, userId } },
      data: { ...data, lastReportAt: new Date() },
    });
  }

  /** Durable projection of a user's self-media controls (Redis stage is authoritative). */
  async setSelfMedia(
    roomId: string,
    userId: string,
    data: { selfMutedAudio?: boolean; selfMutedVideo?: boolean; cameraFacing?: string },
  ): Promise<VideoRoomSession> {
    return this.prisma.videoRoomSession.update({
      where: { roomId_userId: { roomId, userId } },
      data: { ...data, ...auditUpdate(userId) },
    });
  }

  /** End a session (clean leave / eviction), stamping duration. */
  async end(roomId: string, userId: string, durationSeconds: bigint): Promise<VideoRoomSession> {
    return this.prisma.videoRoomSession.update({
      where: { roomId_userId: { roomId, userId } },
      data: {
        status: VideoRoomSessionStatus.ENDED,
        endedAt: new Date(),
        durationSeconds,
        ...auditUpdate(userId),
      },
    });
  }

  /** ACTIVE sessions whose last heartbeat predates `cutoff` (monitor sweep). */
  async findStale(cutoff: Date, limit: number): Promise<VideoRoomSession[]> {
    return this.prisma.videoRoomSession.findMany({
      where: { status: VideoRoomSessionStatus.ACTIVE, lastHeartbeatAt: { lt: cutoff } },
      orderBy: { lastHeartbeatAt: 'asc' },
      take: limit,
    });
  }
}
