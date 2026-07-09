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

  /** True when ZEGO credentials are present (so callers can 503 cleanly). */
  isConfigured(): boolean {
    const cfg = this.config.get('zego') as { appId?: number | string; serverSecret?: string };
    return Boolean(Number(cfg?.appId) && cfg?.serverSecret);
  }

  /**
   * A room-scoped token. `canPublish` controls the ZEGO publish privilege (2);
   * login (1) is always granted. Room binding + privileges live in the payload.
   */
  buildRoomToken(userId: string, roomId: string, canPublish: boolean): ZegoTokenResult {
    const { appId, serverSecret, expiry } = this.creds();
    const payload = JSON.stringify({
      room_id: roomId,
      // ZEGO privilege keys: 1 = login, 2 = publish.
      privilege: { 1: 1, 2: canPublish ? 1 : 0 },
      stream_id_list: null,
    });
    const token = generateToken04(appId, userId, serverSecret, expiry, payload);
    return { appId, token, expiresInSeconds: expiry };
  }
}
