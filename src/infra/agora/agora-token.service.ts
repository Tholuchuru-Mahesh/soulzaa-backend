import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RtcRole, RtcTokenBuilder, RtmTokenBuilder } from 'agora-token';

export type AgoraRole = 'publisher' | 'subscriber';

export interface RtcTokenResult {
  appId: string;
  channel: string;
  uid: number;
  token: string;
  expiresInSeconds: number;
}

/**
 * Issues Agora RTC (audio/video) and RTM (signalling) tokens. This is the only
 * place Agora credentials are used; rooms/live/video-call modules request
 * tokens through it. Credentials are optional in dev — methods throw a clear
 * error if called without them configured.
 */
@Injectable()
export class AgoraTokenService {
  constructor(private readonly config: ConfigService) {}

  private creds(): { appId: string; appCertificate: string; expiry: number } {
    const cfg = this.config.get('agora', { infer: true })!;
    if (!cfg.appId || !cfg.appCertificate) {
      throw new InternalServerErrorException('Agora credentials are not configured');
    }
    return { appId: cfg.appId, appCertificate: cfg.appCertificate, expiry: cfg.tokenExpirySeconds };
  }

  /** RTC token for joining an audio/video channel with a numeric uid. */
  buildRtcToken(channel: string, uid: number, role: AgoraRole = 'publisher'): RtcTokenResult {
    const { appId, appCertificate, expiry } = this.creds();
    const agoraRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
    const privilegeExpire = Math.floor(Date.now() / 1000) + expiry;
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channel,
      uid,
      agoraRole,
      expiry,
      privilegeExpire,
    );
    return { appId, channel, uid, token, expiresInSeconds: expiry };
  }

  /** RTM token for Agora signalling / messaging. */
  buildRtmToken(userId: string): { appId: string; token: string; expiresInSeconds: number } {
    const { appId, appCertificate, expiry } = this.creds();
    const token = RtmTokenBuilder.buildToken(appId, appCertificate, userId, expiry);
    return { appId, token, expiresInSeconds: expiry };
  }
}
