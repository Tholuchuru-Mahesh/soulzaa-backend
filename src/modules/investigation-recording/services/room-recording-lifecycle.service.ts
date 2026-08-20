import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  ZegoCloudRecordingService,
  type CloudRecordingSegmentNotification,
} from 'src/infra/zego/zego-cloud-recording.service';

export interface RecordedSegment {
  fileUrl: string;
  startedAt: Date;
  endedAt: Date;
}

interface StoredSegment {
  fileUrl: string;
  startedAt: string;
  endedAt: string;
}

/**
 * Owns the continuous, whole-room-lifetime ZEGO Cloud Recording task per audio
 * room, persisted in `ZegoRoomRecordingTask` (survives process restarts and
 * works across multiple backend instances, unlike the in-memory buffer this
 * replaced). `EvidenceRecordingProcessorService` reads `getSegmentsForWindow`
 * at report time to assemble the real 4-minute evidence clip.
 *
 * Recording must already be running by the time a report happens — Cloud
 * Recording, like any RTC recording product, only records forward from when
 * the task starts. So this is started when the room's voice session begins
 * (see `RoomRecordingLifecycleListener`), not when a report is filed.
 */
@Injectable()
export class RoomRecordingLifecycleService {
  private readonly logger = new Logger(RoomRecordingLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly zegoRecording: ZegoCloudRecordingService,
    private readonly config: ConfigService,
  ) {}

  private notifyUrl(): string | undefined {
    const cfg = this.config.get('zego') as {
      cloudRecordCallbackBaseUrl?: string;
      cloudRecordCallbackSecret?: string;
    };
    if (!cfg?.cloudRecordCallbackBaseUrl) return undefined;
    const base = `${cfg.cloudRecordCallbackBaseUrl.replace(/\/$/, '')}/api/investigation-recordings/zego/recording-callback`;
    return cfg.cloudRecordCallbackSecret
      ? `${base}?token=${encodeURIComponent(cfg.cloudRecordCallbackSecret)}`
      : base;
  }

  /**
   * Starts (or confirms already-running) continuous recording for a room.
   * Idempotent — safe to call on every voice join, not just the first.
   */
  async ensureRecordingStarted(
    roomId: string,
    roomType: 'audio' | 'video' | 'stream',
  ): Promise<void> {
    const existing = await this.prisma.zegoRoomRecordingTask.findUnique({ where: { roomId } });
    if (existing?.status === 'ACTIVE') return;

    const taskId = `TASK-${roomId}-${Date.now()}`;
    try {
      await this.zegoRecording.startRecording({ roomId, taskId, notifyUrl: this.notifyUrl() });
    } catch (err) {
      this.logger.error(
        `Failed to start continuous Cloud Recording for room ${roomId}: ${(err as Error).message}`,
      );
      await this.prisma.zegoRoomRecordingTask.upsert({
        where: { roomId },
        create: { roomId, taskId, roomType, status: 'FAILED', segments: [] },
        update: { taskId, roomType, status: 'FAILED', stoppedAt: new Date() },
      });
      return;
    }

    await this.prisma.zegoRoomRecordingTask.upsert({
      where: { roomId },
      create: { roomId, taskId, roomType, status: 'ACTIVE', startedAt: new Date(), segments: [] },
      update: {
        taskId,
        roomType,
        status: 'ACTIVE',
        startedAt: new Date(),
        stoppedAt: null,
        segments: [],
      },
    });
    this.logger.log(`Continuous evidence recording started for room ${roomId} (task ${taskId})`);
  }

  /** Stops continuous recording when the room empties or ends. */
  async stopRecording(roomId: string): Promise<void> {
    const task = await this.prisma.zegoRoomRecordingTask.findUnique({ where: { roomId } });
    if (!task || task.status !== 'ACTIVE') return;

    try {
      await this.zegoRecording.stopRecording(task.taskId);
    } catch (err) {
      this.logger.warn(
        `Failed to stop Cloud Recording task ${task.taskId}: ${(err as Error).message}`,
      );
    }
    await this.prisma.zegoRoomRecordingTask.update({
      where: { roomId },
      data: { status: 'STOPPED', stoppedAt: new Date() },
    });
  }

  /** Appends a completed segment reported by ZEGO's recording callback. */
  async recordSegment(notification: CloudRecordingSegmentNotification): Promise<void> {
    const task = await this.prisma.zegoRoomRecordingTask.findFirst({
      where: { taskId: notification.taskId },
    });
    if (!task) {
      this.logger.warn(`Recording callback for unknown task ${notification.taskId} — ignoring`);
      return;
    }

    const segments =
      (Array.isArray(task.segments) ? (task.segments as unknown as StoredSegment[]) : []) ?? [];
    segments.push({
      fileUrl: notification.fileUrl,
      startedAt: notification.startedAt,
      endedAt: notification.endedAt,
    });
    await this.prisma.zegoRoomRecordingTask.update({
      where: { id: task.id },
      data: { segments: segments as unknown as Prisma.InputJsonValue },
    });
  }

  /** Real recorded segments overlapping [windowStart, windowEnd], oldest first. */
  async getSegmentsForWindow(
    roomId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<RecordedSegment[]> {
    const task = await this.prisma.zegoRoomRecordingTask.findUnique({ where: { roomId } });
    if (!task) return [];

    const segments =
      (Array.isArray(task.segments) ? (task.segments as unknown as StoredSegment[]) : []) ?? [];
    return segments
      .map((s) => ({
        fileUrl: s.fileUrl,
        startedAt: new Date(s.startedAt),
        endedAt: new Date(s.endedAt),
      }))
      .filter(
        (s) =>
          s.startedAt.getTime() < windowEnd.getTime() &&
          s.endedAt.getTime() > windowStart.getTime(),
      )
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  /** Whether a (non-FAILED) continuous recording task exists for this room. */
  async hasRecordingTask(roomId: string): Promise<boolean> {
    const task = await this.prisma.zegoRoomRecordingTask.findUnique({ where: { roomId } });
    return !!task && task.status !== 'FAILED';
  }
}
