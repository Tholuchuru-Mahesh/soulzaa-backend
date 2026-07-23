import { MetricsService } from 'src/infra/observability/metrics.service';
import { VideoRoomNotificationMetrics } from './video-room-notification.metrics';

describe('VideoRoomNotificationMetrics', () => {
  it('registers notification metric families on the shared registry', async () => {
    const metrics = new MetricsService();
    const vr = new VideoRoomNotificationMetrics(metrics);
    vr.incNotificationDispatched('SEAT_APPROVAL', 'push');
    vr.incNotificationSuppressed('mute');
    vr.observeFanoutBatch(0.02);
    vr.incFanoutRecipients(5);
    const out = await metrics.registry.metrics();
    expect(out).toContain('video_room_notifications_dispatched_total');
    expect(out).toContain('video_room_notifications_suppressed_total');
    expect(out).toContain('video_room_notification_fanout_batch_duration_seconds');
    expect(out).toContain('video_room_notification_fanout_recipients_total');
  });
});
