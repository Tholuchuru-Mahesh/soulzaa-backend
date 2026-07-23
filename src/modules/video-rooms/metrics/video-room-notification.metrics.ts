import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from 'src/infra/observability/metrics.service';

/** VR-15 notification metrics on the shared /metrics registry. */
@Injectable()
export class VideoRoomNotificationMetrics {
  private readonly dispatched: Counter<'kind' | 'channel'>;
  private readonly suppressed: Counter<'reason'>;
  private readonly fanoutBatch: Histogram<string>;
  private readonly fanoutRecipients: Counter<string>;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];
    this.dispatched = new Counter({
      name: 'video_room_notifications_dispatched_total',
      help: 'Video-room notifications dispatched',
      labelNames: ['kind', 'channel'] as const,
      registers,
    });
    this.suppressed = new Counter({
      name: 'video_room_notifications_suppressed_total',
      help: 'Video-room notifications suppressed',
      labelNames: ['reason'] as const,
      registers,
    });
    this.fanoutBatch = new Histogram({
      name: 'video_room_notification_fanout_batch_duration_seconds',
      help: 'Fan-out chunk handling duration',
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 3],
      registers,
    });
    this.fanoutRecipients = new Counter({
      name: 'video_room_notification_fanout_recipients_total',
      help: 'Recipients delivered via fan-out chunks',
      registers,
    });
  }

  incNotificationDispatched(kind: string, channel: string): void {
    this.dispatched.inc({ kind, channel });
  }

  incNotificationSuppressed(reason: string): void {
    this.suppressed.inc({ reason });
  }

  observeFanoutBatch(seconds: number): void {
    this.fanoutBatch.observe(seconds);
  }

  incFanoutRecipients(n: number): void {
    if (n > 0) this.fanoutRecipients.inc(n);
  }
}
