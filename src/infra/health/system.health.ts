import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import * as os from 'os';

@Injectable()
export class SystemHealthIndicator extends HealthIndicator {
  isHealthy(key: string): Promise<HealthIndicatorResult> {
    const memoryUsage = process.memoryUsage();
    const freeMemory = os.freemem();
    const totalMemory = os.totalmem();
    const cpuLoad = os.loadavg();

    const isMemoryHealthy = freeMemory > 50 * 1024 * 1024; // >50MB free
    const result = this.getStatus(key, isMemoryHealthy, {
      heapUsedMb: Math.round(memoryUsage.heapUsed / (1024 * 1024)),
      rssMb: Math.round(memoryUsage.rss / (1024 * 1024)),
      systemFreeMemoryMb: Math.round(freeMemory / (1024 * 1024)),
      systemTotalMemoryMb: Math.round(totalMemory / (1024 * 1024)),
      cpuLoadAverage: cpuLoad,
    });

    if (isMemoryHealthy) {
      return Promise.resolve(result);
    }

    throw new HealthCheckError('System health check failed: Low free memory', result);
  }
}
