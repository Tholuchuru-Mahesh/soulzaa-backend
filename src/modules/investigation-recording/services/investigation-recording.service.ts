import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditLogService } from 'src/modules/authorization/services/audit-log.service';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { S3Service } from 'src/infra/storage/s3.service';
import {
  EvidenceRecordingProcessorService,
  type CaptureReportEvidenceInput,
} from './evidence-recording-processor.service';

export interface BeginRecordingInput {
  moderatorId: string;
  targetUserId: string;
  roomId?: string;
  liveStreamId?: string;
  /** The room/stream owner's id — used to check the moderator's scope covers them. */
  ownerId?: string;
  /** Omit when opened at room-join time, before the moderator has selected a
   *  reason — `completeRecording` finalizes it. */
  violationReason?: string;
  /** Snapshot of relevant context at action time. */
  evidencePayload?: Record<string, unknown>;
}

export interface CompleteRecordingInput {
  recordingId: string;
  actionTaken: string;
  /** Finalizes `violationReason` if the recording was opened without one
   *  (the join-triggered path). Ignored if the row already has a reason. */
  violationReason?: string;
  evidencePayload?: Record<string, unknown>;
}

/** How long a join-triggered recording may sit ACTIVE with no concluding action before it's swept as abandoned. */
const STALE_RECORDING_HOURS = 12;

@Injectable()
export class InvestigationRecordingService {
  private readonly logger = new Logger(InvestigationRecordingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: WorkforceScopeService,
    @Optional() private readonly auditLog?: AuditLogService,
    @Optional() private readonly processor?: EvidenceRecordingProcessorService,
    @Optional() private readonly s3?: S3Service,
  ) {}

  /**
   * Automatically captures a 4-minute evidence recording window (2m pre + 2m post)
   * when a user submits a report in an audio/video room or live stream.
   */
  async captureReportEvidence(input: CaptureReportEvidenceInput): Promise<string> {
    if (this.processor) {
      return this.processor.captureReportEvidence(input);
    }

    // No processor injected (e.g. a test module wired without it) — open the
    // recording as ACTIVE with no audio yet, rather than claiming a fake
    // COMPLETED recording that has no real content behind it.
    const evidenceId = `EVD-${randomUUID().toUpperCase().replace(/-/g, '').slice(0, 16)}`;
    await this.prisma.investigationRecording.create({
      data: {
        evidenceId,
        moderatorId: '00000000-0000-0000-0000-000000000000',
        targetUserId: input.targetUserId,
        roomId: input.roomType === 'stream' ? null : input.roomId,
        liveStreamId: input.roomType === 'stream' ? input.roomId : null,
        violationReason: input.violationReason,
        status: 'ACTIVE',
      },
    });
    return evidenceId;
  }

  /**
   * Status query for evidence recording (PROCESSING | READY | ERROR).
   */
  async getEvidenceStatus(evidenceId: string) {
    if (this.processor) {
      return this.processor.getEvidenceStatus(evidenceId);
    }
    const rec = await this.prisma.investigationRecording.findUnique({ where: { evidenceId } });
    if (!rec) throw new NotFoundException('Evidence recording not found');
    const payload = (rec.evidencePayload as Record<string, unknown>) || {};
    return {
      evidenceId,
      status:
        rec.status === 'COMPLETED' ? 'READY' : rec.status === 'FAILED' ? 'ERROR' : 'PROCESSING',
      durationSeconds: rec.durationSeconds ?? 240,
      streamUrl: rec.recordingUrl,
      speakerTimeline: (payload.speakerTimeline as any[]) || [],
    };
  }

  /**
   * Retrieves the synchronized speaker activity timeline for an evidence recording.
   */
  async getSpeakerTimeline(evidenceId: string) {
    const status = await this.getEvidenceStatus(evidenceId);
    return {
      evidenceId,
      durationSeconds: status.durationSeconds,
      speakerTimeline: (status as any).speakerTimeline || [],
    };
  }

  /**
   * Retries evidence packaging & upload.
   */
  async retryEvidence(evidenceId: string) {
    if (this.processor) {
      return this.processor.retryEvidenceCapture(evidenceId);
    }
    return false;
  }

  private readonly audioBuffers = new Map<string, { buffer: Buffer; mimeType: string }>();

  /**
   * Stores real recorded mixed room audio for an evidence investigation.
   */
  async saveEvidenceAudio(
    identifier: string,
    audioBuffer: Buffer,
    mimeType = 'audio/aac',
  ): Promise<{ success: boolean; size: number }> {
    this.audioBuffers.set(identifier, { buffer: audioBuffer, mimeType });

    let targetEvidenceId = identifier;
    try {
      const recording = await this.prisma.investigationRecording.findFirst({
        where: {
          OR: [{ evidenceId: identifier }, { roomId: identifier }],
        },
        orderBy: { createdAt: 'desc' },
      });
      if (recording) {
        targetEvidenceId = recording.evidenceId;
        this.audioBuffers.set(targetEvidenceId, { buffer: audioBuffer, mimeType });
      }
    } catch {
      // Lookup failure just means the audio stays keyed by the caller's raw identifier.
    }

    const s3Key = `evidence/recordings/${targetEvidenceId}.${mimeType.includes('wav') ? 'wav' : 'aac'}`;
    if (this.s3) {
      try {
        await this.s3.putObject(s3Key, audioBuffer, mimeType);
        this.logger.log(
          `Uploaded real room evidence audio to S3: ${s3Key} (${audioBuffer.length} bytes)`,
        );
      } catch (err) {
        this.logger.warn(`S3 audio upload fallback to memory buffer: ${(err as Error).message}`);
      }
    }

    try {
      await this.prisma.investigationRecording.updateMany({
        where: { evidenceId: targetEvidenceId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          recordingUrl: `/api/investigation-recordings/stream/${targetEvidenceId}`,
        },
      });
    } catch {
      // No matching row yet (e.g. audio uploaded before the report row was created) — the
      // buffer above is still served from memory/S3, so this is not a hard failure.
    }

    return { success: true, size: audioBuffer.length };
  }

  /**
   * Retrieves media payload for streaming evidence playback. Throws
   * `NotFoundException` — never fabricates audio — if no real recorded room
   * audio was captured for this evidence.
   */
  async getEvidenceMediaPayload(
    evidenceId: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const memoryAudio = this.audioBuffers.get(evidenceId);
    if (memoryAudio && memoryAudio.buffer.length > 0) {
      return { buffer: memoryAudio.buffer, contentType: memoryAudio.mimeType };
    }

    if (this.s3) {
      for (const [key, mime] of [
        [`evidence/recordings/${evidenceId}.m4a`, 'audio/mp4'],
        [`evidence/recordings/${evidenceId}.aac`, 'audio/aac'],
        [`evidence/recordings/${evidenceId}.wav`, 'audio/wav'],
        [`evidence/recordings/${evidenceId}.mp4`, 'video/mp4'],
      ] as const) {
        try {
          const data = await this.s3.getObjectData(key);
          if (data && data.buffer && data.buffer.length > 100) {
            this.audioBuffers.set(evidenceId, { buffer: data.buffer, mimeType: mime });
            return { buffer: data.buffer, contentType: mime };
          }
        } catch {
          // Object doesn't exist at this key — try the next candidate extension.
        }
      }
    }

    throw new NotFoundException(
      'No real recorded room audio is available for this evidence recording yet.',
    );
  }

  /**
   * Opens an investigation recording before a moderation action is performed.
   * Returns the recording row so callers can pass `evidenceId` to the audit log.
   */
  async beginRecording(input: BeginRecordingInput) {
    await this.scopeService.assertModeratorInScope(input.moderatorId, input.ownerId ?? null);

    const evidenceId = `EVD-${randomUUID().toUpperCase().replace(/-/g, '').slice(0, 16)}`;

    const recording = await this.prisma.investigationRecording.create({
      data: {
        evidenceId,
        moderatorId: input.moderatorId,
        targetUserId: input.targetUserId,
        roomId: input.roomId ?? null,
        liveStreamId: input.liveStreamId ?? null,
        violationReason: input.violationReason ?? null,
        evidencePayload: (input.evidencePayload as Prisma.InputJsonValue) ?? undefined,
        status: 'ACTIVE',
      },
    });

    this.logger.debug(`Investigation recording started: ${recording.evidenceId}`);
    return recording;
  }

  /**
   * A moderator's already-open recording against this target in this
   * room/stream, if one exists (e.g. opened when they joined to investigate
   * a pending report). Callers use this before `beginRecording` so an action
   * taken during an existing investigation completes THAT recording (real
   * join→action duration) instead of opening a second, instant one.
   */
  async findActiveRecording(
    moderatorId: string,
    targetUserId: string,
    scope: { roomId?: string; liveStreamId?: string },
  ) {
    return this.prisma.investigationRecording.findFirst({
      where: {
        moderatorId,
        targetUserId,
        status: 'ACTIVE',
        ...(scope.roomId ? { roomId: scope.roomId } : {}),
        ...(scope.liveStreamId ? { liveStreamId: scope.liveStreamId } : {}),
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  /**
   * Opens a recording for a moderator entering a room/stream to investigate
   * a specific pending report — reuses an already-open one for the same
   * (moderator, target, room/stream) rather than stacking duplicates if the
   * join handler fires more than once (reconnects, multiple pending reports
   * resolving to the same target).
   */
  async beginOrReuseRecording(input: BeginRecordingInput) {
    const existing = await this.findActiveRecording(input.moderatorId, input.targetUserId, {
      roomId: input.roomId,
      liveStreamId: input.liveStreamId,
    });
    if (existing) return existing;
    return this.beginRecording(input);
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
        durationSeconds: durationSeconds || 240,
        violationReason: recording.violationReason ?? input.violationReason ?? undefined,
        evidencePayload: (updatedPayload as Prisma.InputJsonValue) ?? undefined,
        recordingUrl:
          recording.recordingUrl || `/api/investigation-recordings/${recording.evidenceId}/stream`,
      },
    });
  }

  async markFailed(recordingId: string) {
    await this.prisma.investigationRecording.updateMany({
      where: { id: recordingId, status: 'ACTIVE' },
      data: { status: 'FAILED', completedAt: new Date() },
    });
  }

  /**
   * Sweeps join-triggered recordings a moderator opened but never concluded
   * (left the room, shift ended, got distracted) — marks them FAILED rather
   * than leaving them ACTIVE forever. Called by
   * `InvestigationRecordingExpiryScheduler`.
   */
  async expireStaleRecordings(olderThanHours = STALE_RECORDING_HOURS): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    const result = await this.prisma.investigationRecording.updateMany({
      where: { status: 'ACTIVE', startedAt: { lt: cutoff } },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    if (result.count > 0) {
      this.logger.warn(`Expired ${result.count} stale ACTIVE investigation recording(s)`);
    }
    return result.count;
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

  async listAll(filters: { status?: string }, page = 1, limit = 20) {
    const where: Record<string, unknown> = {};
    if (filters.status) where['status'] = filters.status;

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

  /**
   * Unified moderation "case" view for a target user: every investigation
   * recording opened against them, joined with every audit log entry
   * recorded against them, newest first. Pure aggregation over two
   * already-queryable tables — no new state, so a moderator or reviewer can
   * see a target's full moderation history in one screen instead of
   * cross-referencing the recordings queue and the audit log separately.
   */
  async getCaseView(targetUserId: string) {
    const [recordings, auditLogs] = await Promise.all([
      this.prisma.investigationRecording.findMany({
        where: { targetUserId },
        orderBy: { startedAt: 'desc' },
      }),
      this.auditLog ? this.auditLog.getAuditLogsForTarget(targetUserId) : Promise.resolve([]),
    ]);

    return { targetUserId, recordings, auditLogs };
  }
}
