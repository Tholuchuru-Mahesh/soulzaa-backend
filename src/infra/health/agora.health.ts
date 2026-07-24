import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AgoraHealthIndicator extends HealthIndicator {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const appId = this.config.get<string>('AGORA_APP_ID');
    const isConfigured = Boolean(appId && appId.length > 0);
    const result = this.getStatus(key, isConfigured, {
      configured: isConfigured,
    });

    if (isConfigured) {
      return result;
    }

    throw new HealthCheckError('Agora health check failed: AGORA_APP_ID missing', result);
  }
}
