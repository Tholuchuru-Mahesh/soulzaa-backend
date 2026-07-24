import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from '../redis/redis.constants';

export interface BenchmarkResult {
  simulatedUsers: number;
  totalOperations: number;
  durationMs: number;
  throughputOpsPerSec: number;
  averageLatencyMs: number;
}

@Injectable()
export class PerformanceBenchmarkService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async runBenchmark(simulatedUsers: number = 1000): Promise<BenchmarkResult> {
    const totalOperations = Math.min(simulatedUsers * 5, 5000);
    const start = Date.now();

    for (let i = 0; i < totalOperations; i++) {
      await this.redis.set(`bench:${i}`, 'val', 'EX', 10);
    }

    const durationMs = Math.max(Date.now() - start, 1);
    const throughputOpsPerSec = Math.round((totalOperations / durationMs) * 1000);
    const averageLatencyMs = Number((durationMs / totalOperations).toFixed(2));

    return {
      simulatedUsers,
      totalOperations,
      durationMs,
      throughputOpsPerSec,
      averageLatencyMs,
    };
  }
}
