import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { PlatformRole } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import {
  PLATFORM_BAN_EVENTS,
  type UserGloballyBannedEvent,
} from 'src/modules/platform-moderation/events/platform-ban.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { ModerationService } from '../services/moderation.service';

/**
 * A 24h platform ban only synchronously ejects the target from the one room
 * the moderator happened to be investigating (handled in
 * `ModerationController.banGlobally` itself). This covers every *other*
 * audio room the target is currently an active member of — the case a user
 * being banned while browsing elsewhere, not the room under investigation.
 *
 * Resolving the banning moderator's real roles (rather than assuming an
 * admin bypass) means `ModerationService.forceDisconnect`'s own
 * owner-protection still applies here: a plain MODERATOR can't eject the
 * room's owner through this path either, exactly as if they'd tried it
 * directly — the room they own (if any) is already handled by
 * `PlatformBanService.endActiveRoomsFor`.
 *
 * Uses `forceDisconnect`, not `kick`: `kick` creates a durable `RoomKick` row
 * that outlives the platform ban entirely (unbanning never knew to lift it),
 * permanently locking the target out of a room they were only ever kicked
 * from as a side effect of a ban that's since been reversed.
 * `forceDisconnect` ends their current session with the same realtime
 * notification but no persistent row — the platform ban's own Redis-backed
 * check is what blocks rejoining, correctly tied to the ban's own lifecycle.
 */
@Injectable()
export class AudioRoomPlatformBanListener implements OnModuleInit {
  private readonly logger = new Logger(AudioRoomPlatformBanListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
    private readonly roles: RoleResolver,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<UserGloballyBannedEvent>(PLATFORM_BAN_EVENTS.USER_BANNED, (e) =>
      this.handleBanned(e),
    );
  }

  private async handleBanned(event: UserGloballyBannedEvent): Promise<void> {
    const { targetUserId, moderatorId, reason } = event.payload;
    try {
      const memberships = await this.prisma.roomMember.findMany({
        where: { userId: targetUserId, isActive: true },
        select: { roomId: true },
      });
      if (memberships.length === 0) return;

      const roleNames = await this.roles.getRoleNames(moderatorId);
      const actor: RoomActor = { id: moderatorId, roles: roleNames as PlatformRole[] };

      for (const { roomId } of memberships) {
        await this.moderation.forceDisconnect(actor, roomId, targetUserId, reason).catch((err) => {
          this.logger.debug(
            `Skipped audio-room ejection for banned user ${targetUserId} in ${roomId}: ${(err as Error).message}`,
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
