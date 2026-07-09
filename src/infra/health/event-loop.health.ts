import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/**
 * Liveness signal: fails when the mean event-loop lag exceeds
 * LIVENESS_MAX_EVENT_LOOP_LAG_MS — i.e. the process is up but too blocked to
 * serve traffic, so an orchestrator should restart it.
 */
@Injectable()
export class EventLoopHealthIndicator implements OnModuleDestroy {
  private readonly histogram: IntervalHistogram;
  private readonly maxLagMs: number;

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    config: ConfigService,
  ) {
    this.maxLagMs = Number(config.get('monitoring', { infer: true })!.livenessMaxEventLoopLagMs);
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
  }

  isHealthy(key: string): HealthIndicatorResult {
    const indicator = this.healthIndicatorService.check(key);
    const meanMs = this.histogram.mean / 1e6; // nanoseconds → ms
    this.histogram.reset();
    return meanMs <= this.maxLagMs
      ? indicator.up({ meanLagMs: Math.round(meanMs) })
      : indicator.down({ meanLagMs: Math.round(meanMs), thresholdMs: this.maxLagMs });
  }

  onModuleDestroy(): void {
    this.histogram.disable();
  }
}
