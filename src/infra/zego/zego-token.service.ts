import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateToken04 } from './generate-token04';

export interface ZegoTokenResult {
  appId: number;
  token: string;
  expiresInSeconds: number;
}

/**
 * Issues ZEGOCLOUD Token04 tokens for room login + publish. This is the only
 * place ZEGO credentials are used; the audio-room voice layer requests tokens
 * through it. Credentials are optional in dev — throws a clear error if a token
 * is requested without them configured. The `payload` binds the token to a room
 * with login/publish privileges so audience tokens cannot publish (server-side).
 */
@Injectable()
export class ZegoTokenService {
  constructor(private readonly config: ConfigService) {}

  private creds(): { appId: number; serverSecret: string; expiry: number } {
    const cfg = this.config.get('zego') as {
      appId: number | string;
      serverSecret: string;
      tokenExpirySeconds: number | string;
    };
    const appId = Number(cfg?.appId);
    if (!appId || !cfg?.serverSecret) {
      throw new InternalServerErrorException('ZEGOCLOUD credentials are not configured');
    }
    return { appId, serverSecret: cfg.serverSecret, expiry: Number(cfg.tokenExpirySeconds) };
  }

  private hasRealConfig(): boolean {
    const cfg = this.config.get('zego') as { appId?: number | string; serverSecret?: string };
    return Boolean(Number(cfg?.appId) && cfg?.serverSecret);
  }

  /** True when ZEGO credentials are present (so callers can 503 cleanly). Returns true in dev to fallback. */
  isConfigured(): boolean {
    const isDev = this.config.get('NODE_ENV') === 'development';
    if (isDev) return true;
    return this.hasRealConfig();
  }

  buildRoomToken(userId: string, roomId: string, canPublish: boolean): ZegoTokenResult {
    if (!this.hasRealConfig()) {
      const isDev = this.config.get('NODE_ENV') === 'development';
      if (isDev) {
        return {
          appId: 1,
          token: 'mock_zego_token_for_dev',
          expiresInSeconds: 3600,
        };
      }
      throw new InternalServerErrorException('ZEGOCLOUD credentials are not configured');
    }
    const { appId, serverSecret, expiry } = this.creds();
    // Provide a detailed privilege payload. If ZEGOCLOUD Console has Token Authentication (Strict Mode)
    // enabled, basic empty tokens will 403/1001004. This payload satisfies both standard and strict modes.
    const payload = JSON.stringify({
      room_id: roomId,
      privilege: {
        '1': 1, // login
        '2': canPublish ? 1 : 0, // publish
      },
      stream_id_list: [],
    });
    const token = generateToken04(appId, userId, serverSecret, expiry, payload);
    return { appId, token, expiresInSeconds: expiry };
  }
}
