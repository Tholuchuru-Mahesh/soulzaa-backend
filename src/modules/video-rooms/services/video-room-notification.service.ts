import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueueService } from 'src/infra/queue/queue.service';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
  type NotificationPreferenceView,
} from 'src/modules/notification/interfaces/notification.interface';
import {
  FanoutSource,
  MatrixRow,
  NotificationAudience,
  PreferenceToggle,
  toPushPriority,
  VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
  VIDEO_ROOM_NOTIFICATION_MATRIX,
  VIDEO_ROOM_NOTIFICATION_MEMBER_FANOUT_THRESHOLD,
  VideoRoomNotificationKind,
} from '../constants/video-room-notification.constants';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomNotificationMuteService } from './video-room-notification-mute.service';
import { VideoRoomNotificationMetrics } from '../metrics/video-room-notification.metrics';

export interface DispatchContext {
  roomId: string;
  targetUserIds?: string[];
  ownerId?: string;
  occurrenceId?: string;
  actorId?: string | null;
  title: string;
  body: string;
  data?: Record<string, string>;
}

/** Fan-out job payload — consumed by VideoRoomNotificationFanoutService (Task 6). */
export interface VideoRoomFanoutJob {
  kind: VideoRoomNotificationKind;
  source: FanoutSource;
  roomId: string;
  ownerId: string;
  occurrenceId: string;
  cursor: number;
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * VR-15 dispatcher — the single seam turning a video-room notification KIND into
 * durable in-app rows + preference-gated push, driven entirely by the matrix.
 * Prisma-free: it composes NotificationService + repositories/services only.
 * FOLLOWERS audiences are handed to a chunked fan-out worker; bounded audiences
 * (TARGET / ROOM_MEMBERS) are resolved and delivered inline.
 */
@Injectable()
export class VideoRoomNotificationService {
  private readonly logger = new Logger(VideoRoomNotificationService.name);

  constructor(
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: INotificationService,
    private readonly mute: VideoRoomNotificationMuteService,
    private readonly rooms: VideoRoomsRepository,
    private readonly queue: QueueService,
    private readonly metrics: VideoRoomNotificationMetrics,
  ) {}

  async dispatch(kind: VideoRoomNotificationKind, ctx: DispatchContext): Promise<void> {
    const row = VIDEO_ROOM_NOTIFICATION_MATRIX[kind];
    if (row.audience === 'FOLLOWERS') {
      if (!ctx.ownerId || !ctx.occurrenceId) {
        this.logger.warn(`FOLLOWERS dispatch for ${kind} missing ownerId/occurrenceId — skipped`);
        return;
      }
      await this.enqueueFanout(kind, 'FOLLOWERS', ctx);
      return;
    }
    await this.deliverBounded(kind, row, ctx);
  }

  /** SYSTEM entrypoint (admin/ops). Audience overridable; defaults to the matrix row. */
  async dispatchSystem(ctx: DispatchContext & { audience?: NotificationAudience }): Promise<void> {
    const kind = 'SYSTEM' as VideoRoomNotificationKind;
    const base = VIDEO_ROOM_NOTIFICATION_MATRIX[kind];
    const audience = ctx.audience ?? base.audience;
    if (audience === 'FOLLOWERS') {
      this.logger.warn('SYSTEM notifications do not support FOLLOWERS audience');
      return;
    }
    await this.deliverBounded(kind, { ...base, audience }, ctx);
  }

  /**
   * Bounded audiences (TARGET / ROOM_MEMBERS). ROOM_MEMBERS in a room larger than
   * the threshold is fanned out to the worker (off the awaited bus path) when a
   * stable occurrenceId is available; otherwise it delivers inline.
   */
  private async deliverBounded(
    kind: VideoRoomNotificationKind,
    row: MatrixRow,
    ctx: DispatchContext,
  ): Promise<void> {
    if (row.audience === 'ROOM_MEMBERS') {
      if (ctx.occurrenceId) {
        const count = await this.rooms.countActiveMembers(ctx.roomId);
        if (count > VIDEO_ROOM_NOTIFICATION_MEMBER_FANOUT_THRESHOLD) {
          await this.enqueueFanout(kind, 'MEMBERS', ctx);
          return;
        }
      }
      const ids = await this.rooms.listActiveMemberIds(ctx.roomId);
      for (const userId of ids) await this.deliverOne(kind, row, userId, ctx);
      return;
    }
    for (const userId of ctx.targetUserIds ?? []) await this.deliverOne(kind, row, userId, ctx);
  }

  private async enqueueFanout(
    kind: VideoRoomNotificationKind,
    source: FanoutSource,
    ctx: DispatchContext,
  ): Promise<void> {
    await this.queue.enqueue<VideoRoomFanoutJob>(
      QUEUE_NAMES.NOTIFICATIONS,
      VIDEO_ROOM_NOTIFICATION_FANOUT_JOB,
      {
        kind,
        source,
        roomId: ctx.roomId,
        ownerId: ctx.ownerId ?? '',
        occurrenceId: ctx.occurrenceId as string,
        cursor: 0,
        title: ctx.title,
        body: ctx.body,
        data: ctx.data,
      },
      {
        jobId: `vrnotif:${ctx.occurrenceId}:0`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );
  }

  /** Shared per-recipient gate + delivery. Reused by the fan-out worker (Task 6). */
  async deliverOne(
    kind: VideoRoomNotificationKind,
    row: MatrixRow,
    userId: string,
    ctx: DispatchContext,
  ): Promise<void> {
    // Per-recipient isolation: a failure for one recipient must never abort the
    // rest of the batch (a ROOM_MEMBERS announcement) nor a fan-out chunk. This
    // is the shared gate for every caller (dispatch + fan-out worker), so it
    // swallows-and-logs here; consistent with the at-most-once fan-out design.
    try {
      if (await this.mute.isMuted(userId, ctx.roomId)) {
        this.metrics.incNotificationSuppressed('mute');
        return;
      }
      const prefs = await this.notifications.preferences(userId);
      if (!this.allowed(prefs, row.preferenceToggle)) {
        this.metrics.incNotificationSuppressed('preference');
        return;
      }

      if (row.channels.inApp) {
        await this.notifications.create({
          userId,
          type: row.notificationType,
          actorId: ctx.actorId ?? null,
          entityType: 'VIDEO_ROOM',
          entityId: ctx.roomId,
          data: { title: ctx.title, body: ctx.body, ...(ctx.data ?? {}) },
        });
        this.metrics.incNotificationDispatched(kind, 'inApp');
      }
      if (row.channels.push) {
        // notify() returns false when the global push policy suppressed it
        // (master switch/snooze) — a normal outcome, not a delivery.
        const sent = await this.notifications.notify(userId, {
          category: row.pushCategory,
          title: ctx.title,
          body: ctx.body,
          priority: toPushPriority(row.severity),
          ttlSeconds: row.ttlSeconds,
          collapseKey: row.collapseKey?.({ roomId: ctx.roomId }),
          data: { roomId: ctx.roomId, kind, ...(ctx.data ?? {}) },
          badge: 'unread',
        });
        if (sent) this.metrics.incNotificationDispatched(kind, 'push');
      }
    } catch (err) {
      this.logger.warn(
        `notification delivery failed (kind=${kind} room=${ctx.roomId} user=${userId}): ${(err as Error).message}`,
      );
      this.metrics.incNotificationSuppressed('error');
    }
  }

  private allowed(prefs: NotificationPreferenceView, toggle: PreferenceToggle): boolean {
    return (prefs as unknown as Record<PreferenceToggle, boolean>)[toggle] === true;
  }
}
