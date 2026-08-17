import { Injectable } from '@nestjs/common';
import {
  LiveStreamReport,
  LiveStreamReportReason,
  LiveStreamReportStatus,
  Prisma,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateLiveStreamReportInput {
  streamId: string;
  reporterId: string;
  targetUserId: string;
  reason: LiveStreamReportReason;
  description?: string | null;
}

/**
 * Persistence for viewer reports against a live stream participant. Mirrors
 * `ModerationRepository`'s `RoomReport` methods (audio-rooms) field-for-field.
 */
@Injectable()
export class LiveStreamReportRepository {
  constructor(private readonly prisma: PrismaService) {}

  createReport(input: CreateLiveStreamReportInput): Promise<LiveStreamReport> {
    return this.prisma.liveStreamReport.create({
      data: {
        streamId: input.streamId,
        reporterId: input.reporterId,
        targetUserId: input.targetUserId,
        reason: input.reason,
        description: input.description ?? null,
        ...auditCreate(input.reporterId),
      },
    });
  }

  getReport(id: string): Promise<LiveStreamReport | null> {
    return this.prisma.liveStreamReport.findUnique({ where: { id } });
  }

  findOpenReport(
    streamId: string,
    reporterId: string,
    targetUserId: string,
  ): Promise<LiveStreamReport | null> {
    return this.prisma.liveStreamReport.findFirst({
      where: { streamId, reporterId, targetUserId, status: LiveStreamReportStatus.PENDING },
    });
  }

  /** Every open (PENDING) report on a stream — powers the join-triggered investigation recording. */
  listPendingReports(streamId: string): Promise<LiveStreamReport[]> {
    return this.prisma.liveStreamReport.findMany({
      where: { streamId, status: LiveStreamReportStatus.PENDING },
    });
  }

  listReports(
    streamId: string,
    skip: number,
    take: number,
    targetUserId?: string,
  ): Promise<[LiveStreamReport[], number]> {
    const where: Prisma.LiveStreamReportWhereInput = {
      streamId,
      ...(targetUserId ? { targetUserId } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.liveStreamReport.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.liveStreamReport.count({ where }),
    ]);
  }

  async reviewReport(
    id: string,
    reviewerId: string,
    status: LiveStreamReportStatus,
    resolutionAction: string | null,
  ): Promise<void> {
    await this.prisma.liveStreamReport.update({
      where: { id },
      data: {
        status,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        resolutionAction,
        ...auditUpdate(reviewerId),
      },
    });
  }

  async addNotes(id: string, notes: string): Promise<void> {
    await this.prisma.liveStreamReport.update({
      where: { id },
      data: { moderatorNotes: notes },
    });
  }
}
