import { DomainEvent } from 'src/common/events';

export const PLATFORM_BAN_EVENTS = {
  USER_BANNED: 'platform-moderation.user-banned',
  USER_UNBANNED: 'platform-moderation.user-unbanned',
} as const;

export interface UserGloballyBannedPayload {
  targetUserId: string;
  moderatorId: string;
  reason: string;
}

export interface UserGloballyUnbannedPayload {
  targetUserId: string;
  moderatorId: string;
  reason?: string;
}

/**
 * Published whenever a 24h platform-wide ban is issued (`PlatformBanService.
 * banUser`). `PlatformBanService` cannot depend on the audio/video/live-stream
 * moderation services directly — they already depend on it (for the create/
 * join ban check), so that would be circular. Each room-type module instead
 * listens for this event and ejects the target from any room of its own type
 * they're *currently* active in, beyond just the room the moderator happened
 * to be investigating when they issued the ban (that room is already covered
 * synchronously by the controller that called `banUser`).
 */
export class UserGloballyBannedEvent extends DomainEvent<UserGloballyBannedPayload> {
  readonly name = PLATFORM_BAN_EVENTS.USER_BANNED;
}

/**
 * Published whenever a 24h platform-wide ban is revoked / lifted (`PlatformBanService.
 * unbanUser`).
 */
export class UserGloballyUnbannedEvent extends DomainEvent<UserGloballyUnbannedPayload> {
  readonly name = PLATFORM_BAN_EVENTS.USER_UNBANNED;
}
