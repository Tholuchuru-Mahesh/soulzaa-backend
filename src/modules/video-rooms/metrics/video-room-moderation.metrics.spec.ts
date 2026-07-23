import { MetricsService } from 'src/infra/observability/metrics.service';
import { VideoRoomModerationMetrics } from './video-room-moderation.metrics';

describe('VideoRoomModerationMetrics', () => {
  let metrics: MetricsService;
  let vr: VideoRoomModerationMetrics;

  beforeEach(() => {
    metrics = new MetricsService();
    vr = new VideoRoomModerationMetrics(metrics);
  });

  it('records a report reason on the shared registry', async () => {
    vr.incReport('SPAM');
    const out = await metrics.registry.getSingleMetricAsString(
      'video_rooms_moderation_reports_total',
    );
    expect(out).toContain('reason="SPAM"');
  });

  it('registers all moderation metric families and accepts every helper', async () => {
    vr.incAction('KICK');
    vr.incKick();
    vr.incKick(3);
    vr.incMute('chat');
    vr.incWarning();
    vr.incReport('HARASSMENT');
    vr.incBlacklist();
    vr.incAutoAction('spam', 'auto_mute');
    vr.observeResponse('kick', 0.25);

    const out = await metrics.registry.metrics();
    expect(out).toContain('video_rooms_moderation_actions_total');
    expect(out).toContain('video_rooms_moderation_kicks_total');
    expect(out).toContain('video_rooms_moderation_mutes_total');
    expect(out).toContain('video_rooms_moderation_warnings_total');
    expect(out).toContain('video_rooms_moderation_reports_total');
    expect(out).toContain('video_rooms_moderation_blacklists_total');
    expect(out).toContain('video_rooms_moderation_auto_actions_total');
    expect(out).toContain('video_rooms_moderation_response_seconds');
  });

  it('labels action/mute/auto-action helpers correctly', async () => {
    vr.incAction('WARN');
    vr.incMute('mic');
    vr.incAutoAction('flood', 'auto_kick');

    const out = await metrics.registry.metrics();
    expect(out).toContain('action="WARN"');
    expect(out).toContain('channel="mic"');
    expect(out).toContain('detector="flood"');
    expect(out).toContain('action="auto_kick"');
  });

  it('incKick defaults to incrementing by 1', async () => {
    vr.incKick();
    const out = await metrics.registry.getSingleMetricAsString(
      'video_rooms_moderation_kicks_total',
    );
    expect(out).toMatch(/video_rooms_moderation_kicks_total 1/);
  });
});
