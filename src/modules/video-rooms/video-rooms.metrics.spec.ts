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
