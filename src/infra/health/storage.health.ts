import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { S3Service } from '../storage/s3.service';

/** Readiness: is the S3/MinIO bucket reachable? */
@Injectable()
export class StorageHealthIndicator {
  constructor(
    private readonly s3: S3Service,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      await this.s3.headBucket();
      return indicator.up();
    } catch (err) {
      return indicator.down({ message: (err as Error).message });
    }
  }
}
