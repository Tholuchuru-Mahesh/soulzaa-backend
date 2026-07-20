import { MediaProviderKind } from '../enums';
import type { IMediaProvider, IssueTokenParams } from '../interfaces/media-provider.interface';
import type { MediaSession } from './media-session';

/**
 * Deterministic IMediaProvider test double. Not registered in the module — it is
 * the reusable seam for unit tests that exercise media-dependent code without a
 * real ZEGO backend. Bind it to MEDIA_PROVIDER in a TestingModule.
 */
export class MockMediaProvider implements IMediaProvider {
  readonly kind = MediaProviderKind.ZEGO;

  constructor(private readonly configured = true) {}

  isConfigured(): boolean {
    return this.configured;
  }

  validateRequest(): void {
    // Always valid in tests.
  }

  issueToken(params: IssueTokenParams): MediaSession {
    return {
      provider: this.kind,
      mediaRoomId: params.mediaRoomId,
      userId: params.userId,
      role: params.role,
      appId: 1,
      token: `mock-token:${params.userId}:${params.mediaRoomId}:${params.role}`,
      expiresInSeconds: 3600,
    };
  }

  refreshToken(params: IssueTokenParams): MediaSession {
    return this.issueToken(params);
  }
}
