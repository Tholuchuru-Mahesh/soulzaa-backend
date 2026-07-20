import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { ZegoTokenService } from 'src/infra/zego/zego-token.service';
import { ConnectionType, MediaProviderKind } from '../enums';
import type { IMediaProvider, IssueTokenParams } from '../interfaces/media-provider.interface';
import type { MediaSession } from './media-session';

/**
 * ZEGOCLOUD adapter for the IMediaProvider seam. It does NOT reimplement token
 * generation — it delegates to the shared, already-vendored ZegoTokenService
 * (the same one audio-rooms + calls use), so the token04 algorithm and ZEGO
 * credentials live in exactly one place. A future provider is a sibling adapter
 * bound to MEDIA_PROVIDER instead of this one; business code never changes.
 */
@Injectable()
export class ZegoMediaProvider implements IMediaProvider {
  readonly kind = MediaProviderKind.ZEGO;

  constructor(private readonly zego: ZegoTokenService) {}

  isConfigured(): boolean {
    return this.zego.isConfigured();
  }

  validateRequest(params: IssueTokenParams): void {
    if (!params.userId || !params.mediaRoomId) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_CONFIG_INVALID,
        'userId and mediaRoomId are required to issue a media token.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!this.zego.isConfigured()) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MEDIA_NOT_CONFIGURED,
        'The video media provider is not configured.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  issueToken(params: IssueTokenParams): MediaSession {
    this.validateRequest(params);
    const canPublish = params.role === ConnectionType.PUBLISHER;
    const result = this.zego.buildRoomToken(params.userId, params.mediaRoomId, canPublish);
    return {
      provider: this.kind,
      mediaRoomId: params.mediaRoomId,
      userId: params.userId,
      role: params.role,
      appId: result.appId,
      token: result.token,
      expiresInSeconds: result.expiresInSeconds,
    };
  }

  refreshToken(params: IssueTokenParams): MediaSession {
    // Refresh = re-issue with the same privileges (mirrors calls' renewToken).
    return this.issueToken(params);
  }
}
