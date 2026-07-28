import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  USER_EVENTS,
  type UserAvatarUpdatedEvent,
  type UserProfileUpdatedEvent,
} from 'src/modules/users/events/user.events';
import { VideoRoomIdentityCache } from '../services/video-room-identity-cache.service';

/**
 * Keeps the room identity cache honest when a user edits their profile.
 *
 * This is what makes the spec's "display name / profile picture changes update
 * live" requirement true without polling: the next room payload that resolves
 * this user re-reads them from Postgres.
 *
 * Every handler is defensive — a Redis failure must not take down the event bus
 * or fail the profile update that triggered it. A stale cached name for up to
 * `VIDEO_ROOM_IDENTITY_TTL_SECONDS` is the worst case.
 */
@Injectable()
export class VideoRoomIdentityCacheListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomIdentityCacheListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly identities: VideoRoomIdentityCache,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<UserProfileUpdatedEvent>(USER_EVENTS.PROFILE_UPDATED, (e) =>
      this.invalidate(e.payload.userId),
    );
    this.bus.subscribe<UserAvatarUpdatedEvent>(USER_EVENTS.AVATAR_UPDATED, (e) =>
      // Only the avatar appears in PublicIdentity; a cover change would be a
      // pointless cache eviction.
      e.payload.kind === 'avatar' ? this.invalidate(e.payload.userId) : undefined,
    );
  }

  private async invalidate(userId: string): Promise<void> {
    try {
      await this.identities.invalidate(userId);
    } catch (err) {
      this.logger.warn(`Identity cache invalidation failed for ${userId}: ${String(err)}`);
    }
  }
}
