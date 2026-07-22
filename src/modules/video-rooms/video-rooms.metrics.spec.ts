import { Registry } from 'prom-client';
import { MetricsService } from 'src/infra/observability/metrics.service';
import { VideoRoomsMetrics } from './video-rooms.metrics';

describe('VideoRoomsMetrics - setPeakViewers', () => {
  let metricsService: MetricsService;
  let metrics: VideoRoomsMetrics;

  beforeEach(() => {
    // Fresh registry per test so metric families don't collide across runs
    // (prom-client throws on duplicate registration within the same registry).
    metricsService = { registry: new Registry() } as MetricsService;
    metrics = new VideoRoomsMetrics(metricsService);
  });

  async function peakViewersValue(): Promise<number | undefined> {
    const json = await metricsService.registry.getMetricsAsJSON();
    const metric = json.find((m) => m.name === 'video_rooms_peak_viewers');
    return metric?.values[0]?.value;
  }

  it('sets the gauge to the first observed value', async () => {
    metrics.setPeakViewers(50);
    await expect(peakViewersValue()).resolves.toBe(50);
  });

  it('does not lower the gauge when a smaller count is observed later', async () => {
    metrics.setPeakViewers(50);
    metrics.setPeakViewers(11);
    await expect(peakViewersValue()).resolves.toBe(50);
  });

  it('raises the gauge when a new high is observed', async () => {
    metrics.setPeakViewers(50);
    metrics.setPeakViewers(11);
    metrics.setPeakViewers(60);
    await expect(peakViewersValue()).resolves.toBe(60);
  });
});

describe('VideoRoomsMetrics — VR-10 gifts', () => {
  it('registers the gift metric families', () => {
    const registry = new Registry();
    new VideoRoomsMetrics({ registry } as never);
    const names = registry.getMetricsAsArray().map((m) => m.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'video_rooms_gifts_sent_total',
        'video_rooms_gift_coins_total',
        'video_rooms_gift_send_latency_seconds',
        'video_rooms_gift_wallet_latency_seconds',
        'video_rooms_gift_queue_depth',
        'video_rooms_gift_animation_queue_depth',
        'video_rooms_gift_failures_total',
        'video_rooms_gift_recovery_total',
        'video_rooms_gift_combos_total',
      ]),
    );
  });

  /**
   * CARDINALITY GUARD. A per-giftId label is unbounded — the catalog grows
   * forever — and would blow up the metric store. Top gifts come from Redis.
   */
  it('labels gifts by category, never by giftId', async () => {
    const registry = new Registry();
    const metrics = new VideoRoomsMetrics({ registry } as never);
    metrics.incGiftSent('LUXURY', 100);
    const dump = JSON.stringify(await registry.getMetricsAsJSON());
    expect(dump).toContain('category');
    expect(dump).toContain('LUXURY');
    expect(dump).not.toContain('giftId');
  });

  it('records coins alongside the send count', async () => {
    const registry = new Registry();
    const metrics = new VideoRoomsMetrics({ registry } as never);
    metrics.incGiftSent('LUXURY', 250);
    const coins = await registry.getSingleMetric('video_rooms_gift_coins_total')?.get();
    expect(coins?.values[0].value).toBe(250);
  });

  it('tracks recovery outcomes separately', async () => {
    const registry = new Registry();
    const metrics = new VideoRoomsMetrics({ registry } as never);
    metrics.incGiftRecovery('success');
    metrics.incGiftRecovery('failure');
    const recovery = await registry.getSingleMetric('video_rooms_gift_recovery_total')?.get();
    expect(recovery?.values).toHaveLength(2);
  });
});
