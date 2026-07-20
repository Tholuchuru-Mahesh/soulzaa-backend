import type { ConnectionType, MediaProviderKind } from '../enums';
import type { MediaSession } from '../media/media-session';

/**
 * DI token for the media provider seam. Bind a concrete adapter (ZegoMediaProvider
 * today) to this token; business code depends on IMediaProvider / MediaTokenService,
 * never on a concrete SDK. Swapping providers = binding a different class here.
 */
export const MEDIA_PROVIDER = Symbol('MEDIA_PROVIDER');

/** Inputs required to mint/refresh a media token for a specific room + user. */
export interface IssueTokenParams {
  userId: string;
  /** The provider room handle (e.g. zegoRoomId), distinct from the app room id. */
  mediaRoomId: string;
  /** PUBLISHER (may publish, seat) or SUBSCRIBER (audience). */
  role: ConnectionType;
}

/**
 * Provider-agnostic media (RTC) port. A concrete adapter wraps a vendor SDK/
 * token service. Future providers are replaceable without changing business
 * logic — only the binding to MEDIA_PROVIDER changes.
 */
export interface IMediaProvider {
  /** Which backend this adapter fronts (advertised on issued sessions). */
  readonly kind: MediaProviderKind;

  /** True when the provider is configured well enough to issue tokens (else callers 503). */
  isConfigured(): boolean;

  /** Validate an issue request; throws a BusinessException if a token cannot be issued. */
  validateRequest(params: IssueTokenParams): void;

  /** Issue a media session (login + publish/subscribe privileges) for the request. */
  issueToken(params: IssueTokenParams): MediaSession;

  /** Re-issue a fresh session for the same request (token refresh). */
  refreshToken(params: IssueTokenParams): MediaSession;
}
