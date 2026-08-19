import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PresenceService } from 'src/infra/redis/presence.service';
import {
  PLATFORM_BAN_EVENTS,
  type UserGloballyBannedEvent,
} from 'src/modules/platform-moderation/events/platform-ban.events';
import { LiveStreamService } from '../services/live-stream.service';

/**
 * Mirrors the Audio/Video Room `PlatformBanListener`s — see the audio one's
 * doc comment for why this exists. Live streams have no durable viewer
 * membership table (presence is Redis-only), so this uses
 * `PresenceService.userLiveStreams` (a reverse index added alongside this
 * listener) instead of a Prisma query. `LiveStreamService.moderateUser` takes
 * a bare `moderatorId` — no role re-resolution needed, matching the
 * live-stream moderation-approval listener.
 */
@Injectable()
export class LiveStreamPlatformBanListener implements OnModuleInit {
  private readonly logger = new Logger(LiveStreamPlatformBanListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly presence: PresenceService,
    private readonly liveStream: LiveStreamService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<UserGloballyBannedEvent>(PLATFORM_BAN_EVENTS.USER_BANNED, (e) =>
      this.handleBanned(e),
    );
  }

  private async handleBanned(event: UserGloballyBannedEvent): Promise<void> {
    const { targetUserId, moderatorId, reason } = event.payload;
    try {
      const streamIds = await this.presence.userLiveStreams(targetUserId);
      if (streamIds.length === 0) return;

      for (const streamId of streamIds) {
        await this.liveStream
          .moderateUser({ streamId, moderatorId, targetUserId, action: 'KICK', reason })
          .catch((err) => {
            this.logger.debug(
              `Skipped live-stream ejection for banned user ${targetUserId} in ${streamId}: ${(err as Error).message}`,
            );
          });
      }
    } catch (err) {
      this.logger.error(
        `Failed to process platform ban ejection for ${targetUserId}: ${(err as Error).message}`,
      );
    }
  }
}
