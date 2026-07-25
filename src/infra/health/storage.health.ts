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
      // S3 answers HeadBucket with an empty body, so the SDK often has no error
      // code to report and `message` degrades to a bare "UnknownError". The name
      // and status code are what actually identify the fault: 301 = wrong region
      // (see x-amz-bucket-region), 403 = missing s3:ListBucket, 404 = no bucket,
      // CredentialsProviderError = the credential chain resolved nothing.
      const e = err as Error & { $metadata?: { httpStatusCode?: number } };
      return indicator.down({
        message: e.message,
        errorName: e.name,
        httpStatusCode: e.$metadata?.httpStatusCode,
      });
    }
  }
}
