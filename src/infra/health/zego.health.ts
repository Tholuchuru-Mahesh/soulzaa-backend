import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { ZegoTokenService } from '../zego/zego-token.service';

/**
 * Deep check: are ZEGOCLOUD credentials present? ZEGO is the live RTC provider
 * (calls + video rooms + audio-room voice), so without credentials every token
 * request 500s and users can't join a room — the API is otherwise healthy, which
 * is why this is a deep check rather than a readiness gate.
 */
@Injectable()
export class ZegoHealthIndicator {
  constructor(
    private readonly zego: ZegoTokenService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    // isConfigured() is credential-presence only (no network call), and returns
    // true in development so local runs don't fail on the dev mock token path.
    const configured = this.zego.isConfigured();
    return configured
      ? indicator.up({ configured })
      : indicator.down({ configured, message: 'ZEGO_APP_ID / ZEGO_SERVER_SECRET not set' });
  }
}
