import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

export interface BeginRecordingInput {
  moderatorId: string;
  targetUserId: string;
  roomId?: string;
  liveStreamId?: string;
  regionId?: string;
  violationReason: string;
  /** Snapshot of relevant context at action time. */
  evidencePayload?: Record<string, unknown>;
}

export interface CompleteRecordingInput {
  recordingId: string;
  actionTaken: string;
  evidencePayload?: Record<string, unknown>;
}

@Injectable()
export class InvestigationRecordingService {
  private readonly logger = new Logger(InvestigationRecordingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens an investigation recording before a moderation action is performed.
   * Returns the recording row so callers can pass `evidenceId` to the audit log.
   */
  async beginRecording(input: BeginRecordingInput) {
    const evidenceId = `EVD-${randomUUID().toUpperCase().replace(/-/g, '').slice(0, 16)}`;

    const recording = await this.prisma.investigationRecording.create({
      data: {
        evidenceId,
        moderatorId: input.moderatorId,
        targetUserId: input.targetUserId,
        roomId: input.roomId ?? null,
        liveStreamId: input.liveStreamId ?? null,
        regionId: input.regionId ?? null,
        violationReason: input.violationReason,
        evidencePayload: (input.evidencePayload as Prisma.InputJsonValue) ?? undefined,
        status: 'ACTIVE',
      },
    });

    this.logger.debug(`Investigation recording started: ${recording.evidenceId}`);
    return recording;
  }

  /**
   * Marks a recording as COMPLETED after the moderation action has concluded.
   * Updates the evidence payload and action taken, calculates duration.
   */
  async completeRecording(input: CompleteRecordingInput) {
    const recording = await this.prisma.investigationRecording.findUnique({
      where: { id: input.recordingId },
    });

    if (!recording) {
      this.logger.warn(`Recording ${input.recordingId} not found for completion`);
      return null;
    }

    if (recording.status !== 'ACTIVE') return recording;

    const completedAt = new Date();
    const durationSeconds = Math.round(
      (completedAt.getTime() - recording.startedAt.getTime()) / 1000,
    );

    const updatedPayload = input.evidencePayload
      ? { ...(recording.evidencePayload as object), ...(input.evidencePayload as object) }
      : (recording.evidencePayload as object);

    return this.prisma.investigationRecording.update({
      where: { id: input.recordingId },
      data: {
        status: 'COMPLETED',
        actionTaken: input.actionTaken,
        completedAt,
        durationSeconds,
        evidencePayload: (updatedPayload as Prisma.InputJsonValue) ?? undefined,
      },
    });
  }

  async markFailed(recordingId: string) {
    await this.prisma.investigationRecording.updateMany({
      where: { id: recordingId, status: 'ACTIVE' },
      data: { status: 'FAILED', completedAt: new Date() },
    });
  }

  async getRecording(id: string) {
    const recording = await this.prisma.investigationRecording.findUnique({ where: { id } });
    if (!recording) throw new NotFoundException('Investigation recording not found');
    return recording;
  }

  async getByEvidenceId(evidenceId: string) {
    const recording = await this.prisma.investigationRecording.findUnique({
      where: { evidenceId },
    });
    if (!recording) throw new NotFoundException('Evidence not found');
    return recording;
  }

  async listRecordings(
    filters: { moderatorId?: string; targetUserId?: string },
    page = 1,
    limit = 20,
  ) {
    const where: Record<string, unknown> = {};
    if (filters.moderatorId) where['moderatorId'] = filters.moderatorId;
    if (filters.targetUserId) where['targetUserId'] = filters.targetUserId;

    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.investigationRecording.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.investigationRecording.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async listByModerator(moderatorId: string, page = 1, limit = 20) {
    return this.listRecordings({ moderatorId }, page, limit);
  }

  async listAll(filters: { status?: string; regionId?: string }, page = 1, limit = 20) {
    const where: Record<string, unknown> = {};
    if (filters.status) where['status'] = filters.status;
    if (filters.regionId) where['regionId'] = filters.regionId;

    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.investigationRecording.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.investigationRecording.count({ where }),
    ]);
    return { items, total, page, limit };
  }
}
