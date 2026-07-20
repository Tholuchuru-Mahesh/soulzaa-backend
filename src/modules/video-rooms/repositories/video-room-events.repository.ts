import { Injectable } from '@nestjs/common';
import {
  Prisma,
  VideoRoomAnnouncement,
  VideoRoomEvent,
  VideoRoomSnapshot,
  VideoRoomSnapshotReason,
} from '@prisma/client';
import { auditCreate, auditSoftDelete, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface AppendEventInput {
  roomId: string;
  actorId?: string | null;
  eventType: string;
  payload?: Prisma.InputJsonValue;
  referenceId?: string | null;
  correlationId?: string | null;
}

export interface SaveSnapshotInput {
  roomId: string;
  version: number;
  reason?: VideoRoomSnapshotReason;
  state: Prisma.InputJsonValue;
}

export interface CreateAnnouncementInput {
  roomId: string;
  authorId: string;
  content: string;
  isPinned?: boolean;
}

/**
 * Persistence for the video-room event stream (`video_room_events`), recovery
 * snapshots (`video_room_snapshots`), and room announcements
 * (`video_room_announcements`). Events + snapshots are append-only; announcements
 * are editable/soft-deletable. Pure persistence — replay/recovery orchestration
 * lands with the recovery phase.
 */
@Injectable()
export class VideoRoomEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Event stream (append-only) ----

  async appendEvent(input: AppendEventInput): Promise<void> {
    await this.prisma.videoRoomEvent.create({
      data: {
        roomId: input.roomId,
        actorId: input.actorId ?? null,
        eventType: input.eventType,
        payload: input.payload,
        referenceId: input.referenceId ?? null,
        correlationId: input.correlationId ?? null,
      },
    });
  }

  /** Recent events for a room (newest first). */
  async listEvents(roomId: string, take: number): Promise<VideoRoomEvent[]> {
    return this.prisma.videoRoomEvent.findMany({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** Events sharing a correlation id (one causal flow), oldest first. */
  async listByCorrelation(correlationId: string): Promise<VideoRoomEvent[]> {
    return this.prisma.videoRoomEvent.findMany({
      where: { correlationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ---- Snapshots (append-only) ----

  async saveSnapshot(input: SaveSnapshotInput): Promise<VideoRoomSnapshot> {
    return this.prisma.videoRoomSnapshot.create({
      data: {
        roomId: input.roomId,
        version: input.version,
        reason: input.reason ?? VideoRoomSnapshotReason.PERIODIC,
        state: input.state,
      },
    });
  }

  /** The latest snapshot for a room, or null (the recovery entry point). */
  async findLatestSnapshot(roomId: string): Promise<VideoRoomSnapshot | null> {
    return this.prisma.videoRoomSnapshot.findFirst({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Prune snapshots older than `cutoff` (retention). Returns the count removed. */
  async pruneSnapshots(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.videoRoomSnapshot.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }

  // ---- Announcements (editable + soft delete) ----

  async createAnnouncement(input: CreateAnnouncementInput): Promise<VideoRoomAnnouncement> {
    return this.prisma.videoRoomAnnouncement.create({
      data: {
        roomId: input.roomId,
        authorId: input.authorId,
        content: input.content,
        isPinned: input.isPinned ?? false,
        ...auditCreate(input.authorId),
      },
    });
  }

  /** Non-deleted announcements for a room (pinned first, then newest). */
  async listAnnouncements(roomId: string): Promise<VideoRoomAnnouncement[]> {
    return this.prisma.videoRoomAnnouncement.findMany({
      where: { roomId, deletedAt: null },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async updateAnnouncement(
    id: string,
    data: Prisma.VideoRoomAnnouncementUpdateInput,
    actorId: string,
  ): Promise<VideoRoomAnnouncement> {
    return this.prisma.videoRoomAnnouncement.update({
      where: { id },
      data: { ...data, ...auditUpdate(actorId) },
    });
  }

  /** Soft-delete an announcement. */
  async softDeleteAnnouncement(id: string, actorId: string): Promise<VideoRoomAnnouncement> {
    return this.prisma.videoRoomAnnouncement.update({
      where: { id },
      data: auditSoftDelete(actorId),
    });
  }
}
