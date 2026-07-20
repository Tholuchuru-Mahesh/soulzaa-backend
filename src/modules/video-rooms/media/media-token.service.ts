import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConnectionType } from '../enums';
import {
  MEDIA_PROVIDER,
  type IMediaProvider,
  type IssueTokenParams,
} from '../interfaces/media-provider.interface';
import type { MediaSession } from './media-session';

/** Issue a media session for a user in a room. */
export interface IssueForRoomInput {
  userId: string;
  /** The provider room handle; if omitted a fresh one is minted (lazy provisioning). */
  mediaRoomId?: string;
  /** True when the user occupies a seat (may publish); false for the audience. */
  canPublish: boolean;
}

/**
 * Video-room façade over the injected IMediaProvider. Adds the video-room
 * concerns the raw provider should not own: minting a provider room handle for a
 * new room (lazy provisioning) and deriving the publish role from seat state.
 * Business services depend on this, never on a concrete SDK.
 */
@Injectable()
export class MediaTokenService {
  constructor(@Inject(MEDIA_PROVIDER) private readonly provider: IMediaProvider) {}

  /** Whether the underlying provider can currently issue tokens (callers 503 if not). */
  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  /** Mint a fresh provider room handle for a new room (distinct from the app room id). */
  mintMediaRoomId(): string {
    return randomUUID();
  }

  /** Issue a media session, deriving PUBLISHER/SUBSCRIBER from seat state. */
  issueForRoom(input: IssueForRoomInput): MediaSession {
    const params: IssueTokenParams = {
      userId: input.userId,
      mediaRoomId: input.mediaRoomId ?? this.mintMediaRoomId(),
      role: input.canPublish ? ConnectionType.PUBLISHER : ConnectionType.SUBSCRIBER,
    };
    return this.provider.issueToken(params);
  }

  /** Refresh (re-issue) a session for the same user/room/role. */
  refresh(params: IssueTokenParams): MediaSession {
    return this.provider.refreshToken(params);
  }
}
