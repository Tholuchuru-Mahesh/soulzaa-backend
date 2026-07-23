import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from 'src/infra/observability/metrics.service';

/**
 * VR-16 moderation metrics on the shared /metrics registry (mirrors the
 * `VideoRoomsMetrics` / `VideoRoomNotificationMetrics` pattern: prom-client
 * families registered against `metrics.registry`, exposed via thin
 * inc-/observe- helpers so services never touch prom-client directly).
 */
@Injectable()
export class VideoRoomModerationMetrics {
  private readonly actions: Counter<'action'>;
  private readonly kicks: Counter<string>;
  private readonly mutes: Counter<'channel'>;
  private readonly warnings: Counter<string>;
  private readonly reports: Counter<'reason'>;
  private readonly blacklists: Counter<string>;
  private readonly autoActions: Counter<'detector' | 'action'>;
  private readonly responseDuration: Histogram<'action'>;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];
    this.actions = new Counter({
      name: 'video_rooms_moderation_actions_total',
      help: 'Moderation actions recorded, by action type',
      labelNames: ['action'] as const,
      registers,
    });
    this.kicks = new Counter({
      name: 'video_rooms_moderation_kicks_total',
      help: 'Video-room members kicked (single + multi-kick)',
      registers,
    });
    this.mutes = new Counter({
      name: 'video_rooms_moderation_mutes_total',
      help: 'Video-room mutes applied, by channel',
      labelNames: ['channel'] as const,
      registers,
    });
    this.warnings = new Counter({
      name: 'video_rooms_moderation_warnings_total',
      help: 'Video-room warnings issued',
      registers,
    });
    this.reports = new Counter({
      name: 'video_rooms_moderation_reports_total',
      help: 'Video-room user/message reports filed, by reason',
      labelNames: ['reason'] as const,
      registers,
    });
    this.blacklists = new Counter({
      name: 'video_rooms_moderation_blacklists_total',
      help: 'Video-room blacklist entries added',
      registers,
    });
    this.autoActions = new Counter({
      name: 'video_rooms_moderation_auto_actions_total',
      help: 'Automated-moderation actions taken, by detector and action',
      labelNames: ['detector', 'action'] as const,
      registers,
    });
    this.responseDuration = new Histogram({
      name: 'video_rooms_moderation_response_seconds',
      help: 'Time to carry out a moderation action, by action type',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      labelNames: ['action'] as const,
      registers,
    });
  }

  incAction(action: string): void {
    this.actions.inc({ action });
  }

  incKick(n = 1): void {
    this.kicks.inc(n);
  }

  incMute(channel: string): void {
    this.mutes.inc({ channel });
  }

  incWarning(): void {
    this.warnings.inc();
  }

  incReport(reason: string): void {
    this.reports.inc({ reason });
  }

  incBlacklist(): void {
    this.blacklists.inc();
  }

  incAutoAction(detector: string, action: string): void {
    this.autoActions.inc({ detector, action });
  }

  observeResponse(action: string, seconds: number): void {
    this.responseDuration.observe({ action }, seconds);
  }
}
