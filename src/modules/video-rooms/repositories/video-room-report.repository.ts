import { Injectable } from '@nestjs/common';
import {
  Prisma,
  VideoRoomReport,
  VideoRoomReportReason,
  VideoRoomReportStatus,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateVideoRoomReportInput {
  roomId: string;
  reporterId: string;
  targetUserId: string;
  messageId?: string | null;
  reason: VideoRoomReportReason;
  description?: string | null;
}

export interface ListVideoRoomReportsParams {
  skip: number;
  take: number;
  targetUserId?: string;
}

/**
 * Persistence for `video_room_reports` — a member-filed report against a user
 * (and, optionally, a specific chat message) within a room. PENDING until a
 * moderator reviews it. Mirrors the Audio Room `ModerationRepository`'s
 * report methods (`createReport`/`getReport`/`findOpenReport`/`listReports`/
 * `reviewReport`), scoped down to this module's own naming. Pure persistence
 * — dup-guard/permission/notification logic lives in the service.
 */
@Injectable()
export class VideoRoomReportRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateVideoRoomReportInput): Promise<VideoRoomReport> {
    return this.prisma.videoRoomReport.create({
      data: {
        roomId: input.roomId,
        reporterId: input.reporterId,
        targetUserId: input.targetUserId,
        messageId: input.messageId ?? null,
        reason: input.reason,
        description: input.description ?? null,
        ...auditCreate(input.reporterId),
      },
    });
  }

  async getById(id: string): Promise<VideoRoomReport | null> {
    return this.prisma.videoRoomReport.findUnique({ where: { id } });
  }

  /** An already-open (PENDING) report by this reporter against this target, or null (dup-guard). */
  async findOpen(
    roomId: string,
    reporterId: string,
    targetUserId: string,
    messageId?: string,
  ): Promise<VideoRoomReport | null> {
    return this.prisma.videoRoomReport.findFirst({
      where: {
        roomId,
        reporterId,
        targetUserId,
        status: VideoRoomReportStatus.PENDING,
        ...(messageId !== undefined ? { messageId } : {}),
      },
    });
  }

  /** Every open (PENDING) report in a room — powers the join-triggered investigation recording. */
  listPendingReports(roomId: string): Promise<VideoRoomReport[]> {
    return this.prisma.videoRoomReport.findMany({
      where: { roomId, status: VideoRoomReportStatus.PENDING },
    });
  }

  /** Assigns a PENDING report to a moderator for investigation — powers `myAssignedQueue`. */
  async assign(id: string, assigneeId: string): Promise<void> {
    await this.prisma.videoRoomReport.update({
      where: { id },
      data: { assigneeId, assignedAt: new Date() },
    });
  }

  async review(
    id: string,
    reviewerId: string,
    status: VideoRoomReportStatus,
    resolutionAction?: string | null,
  ): Promise<void> {
    await this.prisma.videoRoomReport.update({
      where: { id },
      data: {
        status,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        resolutionAction: resolutionAction ?? null,
        ...auditUpdate(reviewerId),
      },
    });
  }

  async updateNotes(id: string, reviewerId: string, notes: string): Promise<void> {
    await this.prisma.videoRoomReport.update({
      where: { id },
      data: {
        moderatorNotes: notes,
        ...auditUpdate(reviewerId),
      },
    });
  }

  list(roomId: string, params: ListVideoRoomReportsParams): Promise<[VideoRoomReport[], number]> {
    const where: Prisma.VideoRoomReportWhereInput = {
      roomId,
      ...(params.targetUserId ? { targetUserId: params.targetUserId } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.videoRoomReport.findMany({
        where,
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.videoRoomReport.count({ where }),
    ]);
  }
}
