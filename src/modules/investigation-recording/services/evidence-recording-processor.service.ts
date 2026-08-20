import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { S3Service } from 'src/infra/storage/s3.service';
import { RoomMediaBufferService } from './room-media-buffer.service';
import { RoomRecordingLifecycleService } from './room-recording-lifecycle.service';
import { downloadAndTrimSegments } from './audio-trim.util';

export interface CaptureReportEvidenceInput {
  reportId: string;
  roomId: string;
  roomType: 'audio' | 'video' | 'stream';
  targetUserId: string;
  reporterId: string;
  violationReason: string;
  description?: string;
  ownerId?: string | null;
}

export interface EvidenceProcessingState {
  evidenceId: string;
  reportId: string;
  roomId: string;
  targetUserId: string;
  windowStart: Date;
  windowEnd: Date;
  status: 'PROCESSING' | 'READY' | 'ERROR';
  errorDetails?: string;
}

@Injectable()
export class EvidenceRecordingProcessorService {
  private readonly logger = new Logger(EvidenceRecordingProcessorService.name);
  private readonly activeJobs = new Map<string, EvidenceProcessingState>();
  private readonly postWindowSeconds = 120; // 2 minutes post-report buffer
  private readonly preWindowSeconds = 120; // 2 minutes pre-report buffer

  constructor(
    private readonly prisma: PrismaService,
    private readonly bufferService: RoomMediaBufferService,
    private readonly roomRecording: RoomRecordingLifecycleService,
    @Optional() private readonly s3?: S3Service,
  ) {}

  /**
   * Automatically triggered when a user files a report.
   * 1. Computes the [report-2m, report+2m] evidence window.
   * 2. Creates the InvestigationRecording row with status 'ACTIVE' (displayed as PROCESSING).
   * 3. Waits for the post-window to actually elapse, then packages the real
   *    recorded room audio (see `finalizeEvidenceRecording`) covering it.
   */
  async captureReportEvidence(input: CaptureReportEvidenceInput): Promise<string> {
    const reportTimestamp = new Date();
    const evidenceId = `EVD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    const windowStart = new Date(reportTimestamp.getTime() - this.preWindowSeconds * 1000);
    const windowEnd = new Date(reportTimestamp.getTime() + this.postWindowSeconds * 1000);

    this.logger.log(
      `Starting 4-minute evidence capture for report ${input.reportId} in room ${input.roomId} (window ${windowStart.toISOString()} - ${windowEnd.toISOString()}).`,
    );

    const speakerTimeline = this.bufferService.getSpeakerTimelineSlice(
      input.roomId,
      windowStart,
      windowEnd,
      input.targetUserId,
      input.reporterId,
    );
    const hasRecordingTask = await this.roomRecording.hasRecordingTask(input.roomId);

    // 2. Persist initial InvestigationRecording record
    await this.prisma.investigationRecording.create({
      data: {
        evidenceId,
        moderatorId: '00000000-0000-0000-0000-000000000000', // Default system moderator until assigned
        targetUserId: input.targetUserId,
        roomId: input.roomType === 'stream' ? null : input.roomId,
        liveStreamId: input.roomType === 'stream' ? input.roomId : null,
        violationReason: input.violationReason,
        evidencePayload: {
          reportId: input.reportId,
          reporterId: input.reporterId,
          roomType: input.roomType,
          capturedAt: reportTimestamp.toISOString(),
          preBufferDurationSeconds: this.preWindowSeconds,
          postBufferDurationSeconds: this.postWindowSeconds,
          totalTargetDurationSeconds: this.preWindowSeconds + this.postWindowSeconds,
          description: input.description ?? null,
          speakerTimeline: speakerTimeline as unknown as Prisma.InputJsonValue,
          audioSourceAvailable: hasRecordingTask,
        } as Prisma.InputJsonObject,
        status: 'ACTIVE', // Displayed as PROCESSING to moderators
        startedAt: windowStart,
      },
    });

    const jobState: EvidenceProcessingState = {
      evidenceId,
      reportId: input.reportId,
      roomId: input.roomId,
      targetUserId: input.targetUserId,
      windowStart,
      windowEnd,
      status: 'PROCESSING',
    };
    this.activeJobs.set(evidenceId, jobState);

    // Wait for the post-window to actually elapse so the real recording
    // segments covering it exist before we try to fetch them.
    const waitMs = process.env.NODE_ENV === 'test' ? 100 : this.postWindowSeconds * 1000;
    setTimeout(() => {
      void this.finalizeEvidenceRecording(evidenceId);
    }, waitMs);

    return evidenceId;
  }

  /**
   * Finalizes the 4-minute evidence recording: fetches the real recorded
   * segments covering [windowStart, windowEnd] from the room's continuous
   * Cloud Recording task, trims them to the exact window, uploads the real
   * clip to S3, and updates DB status. Marks the recording FAILED — never
   * fabricates audio — if no real segments are available for the window.
   */
  async finalizeEvidenceRecording(evidenceId: string): Promise<void> {
    const job = this.activeJobs.get(evidenceId);
    try {
      if (!job) {
        throw new Error(
          `No in-memory job state for evidence ${evidenceId} (process restarted mid-window?)`,
        );
      }

      const segments = await this.roomRecording.getSegmentsForWindow(
        job.roomId,
        job.windowStart,
        job.windowEnd,
      );
      if (segments.length === 0) {
        throw new Error(
          'No real recorded room audio is available for this window (continuous Cloud Recording was not active for this room, or ZEGO has not yet delivered the recording segments).',
        );
      }

      const mediaPayload = await downloadAndTrimSegments(segments, job.windowStart, job.windowEnd);
      const totalDurationSeconds = this.preWindowSeconds + this.postWindowSeconds; // 240 seconds = 4 minutes
      const s3Key = `evidence/recordings/${evidenceId}.m4a`;
      const mimeType = 'audio/mp4';

      const storageUrl = `/api/investigation-recordings/${evidenceId}/stream`;
      if (this.s3) {
        await this.s3.putObject(s3Key, mediaPayload, mimeType);
        this.logger.log(
          `Uploaded real evidence recording to S3: ${s3Key} (${mediaPayload.length} bytes)`,
        );
      }

      await this.prisma.investigationRecording.update({
        where: { evidenceId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          durationSeconds: totalDurationSeconds,
          recordingUrl: storageUrl,
        },
      });

      job.status = 'READY';
      this.logger.log(
        `Evidence recording ${evidenceId} is READY (4 minutes duration, real room audio).`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to finalize evidence recording ${evidenceId}: ${(err as Error).message}`,
      );
      if (job) {
        job.status = 'ERROR';
        job.errorDetails = (err as Error).message;
      }
      await this.prisma.investigationRecording.updateMany({
        where: { evidenceId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          evidencePayload: {
            error: (err as Error).message,
            failedAt: new Date().toISOString(),
          },
        },
      });
    }
  }

  /**
   * Retrieves live status for an active or completed recording job.
   */
  async getEvidenceStatus(evidenceId: string): Promise<{
    evidenceId: string;
    status: 'PROCESSING' | 'READY' | 'ERROR';
    durationSeconds: number;
    streamUrl?: string;
    errorDetails?: string;
    speakerTimeline?: any[];
  }> {
    const job = this.activeJobs.get(evidenceId);
    if (job && job.status === 'PROCESSING') {
      return {
        evidenceId,
        status: 'PROCESSING',
        durationSeconds: this.preWindowSeconds + this.postWindowSeconds,
      };
    }

    const recording = await this.prisma.investigationRecording.findUnique({
      where: { evidenceId },
    });

    if (!recording) {
      return {
        evidenceId,
        status: 'ERROR',
        durationSeconds: 0,
        errorDetails: 'Evidence record not found',
      };
    }

    const payload = (recording.evidencePayload as Record<string, unknown>) || {};
    const speakerTimeline = (payload.speakerTimeline as any[]) || [];

    if (recording.status === 'COMPLETED') {
      return {
        evidenceId,
        status: 'READY',
        durationSeconds:
          recording.durationSeconds ?? this.preWindowSeconds + this.postWindowSeconds,
        streamUrl: recording.recordingUrl || `/api/investigation-recordings/${evidenceId}/stream`,
        speakerTimeline,
      };
    }

    if (recording.status === 'FAILED') {
      return {
        evidenceId,
        status: 'ERROR',
        durationSeconds: 0,
        errorDetails: (recording.evidencePayload as any)?.error || 'Evidence capture failed',
        speakerTimeline,
      };
    }

    return {
      evidenceId,
      status: 'PROCESSING',
      durationSeconds: this.preWindowSeconds + this.postWindowSeconds,
      speakerTimeline,
    };
  }

  /**
   * Retries evidence packaging & upload if a previous attempt failed.
   */
  async retryEvidenceCapture(evidenceId: string): Promise<boolean> {
    const recording = await this.prisma.investigationRecording.findUnique({
      where: { evidenceId },
    });
    if (!recording) return false;

    await this.prisma.investigationRecording.update({
      where: { evidenceId },
      data: { status: 'ACTIVE' },
    });

    if (!this.activeJobs.has(evidenceId)) {
      const payload = (recording.evidencePayload as Record<string, unknown>) || {};
      const preSeconds = Number(payload.preBufferDurationSeconds ?? this.preWindowSeconds);
      const postSeconds = Number(payload.postBufferDurationSeconds ?? this.postWindowSeconds);
      const reportedAt = payload.capturedAt
        ? new Date(String(payload.capturedAt))
        : recording.startedAt;
      this.activeJobs.set(evidenceId, {
        evidenceId,
        reportId: String(payload.reportId ?? ''),
        roomId: recording.roomId || recording.liveStreamId || '',
        targetUserId: recording.targetUserId,
        windowStart: new Date(reportedAt.getTime() - preSeconds * 1000),
        windowEnd: new Date(reportedAt.getTime() + postSeconds * 1000),
        status: 'PROCESSING',
      });
    }

    void this.finalizeEvidenceRecording(evidenceId);
    return true;
  }
}
