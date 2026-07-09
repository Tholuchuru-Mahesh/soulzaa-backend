import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class QueueHealthIndicator {
  constructor(
    private readonly queues: QueueService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const ok = await this.queues.isHealthy();
      return ok ? indicator.up() : indicator.down({ message: 'queue connection not ready' });
    } catch (err) {
      return indicator.down({ message: (err as Error).message });
    }
  }
}
