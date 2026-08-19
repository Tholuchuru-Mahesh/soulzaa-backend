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
import { VideoRoomModerationService } from '../services/video-room-moderation.service';

/**
 * Mirrors the Audio Room `AudioRoomPlatformBanListener` — see its doc comment
 * for why this exists (ejecting the target from every OTHER video room
 * they're currently active in, beyond the one room the controller already
 * ejects them from synchronously), why roles are re-resolved fresh rather
 * than assuming an admin bypass, and why this uses `forceDisconnect` (no
 * durable block, session ends now) rather than `kick` (which would deactivate
 * their room membership — a state `unbanUser` has no reason to know to
 * reverse, permanently stranding them out of that room after the platform
 * ban is long gone).
 */
@Injectable()
export class VideoRoomPlatformBanListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomPlatformBanListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly prisma: PrismaService,
    private readonly moderation: VideoRoomModerationService,
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
      const memberships = await this.prisma.videoRoomMember.findMany({
        where: { userId: targetUserId, isActive: true },
        select: { roomId: true },
      });
      if (memberships.length === 0) return;

      const roleNames = await this.roles.getRoleNames(moderatorId);
      const actor: RoomActor = { id: moderatorId, roles: roleNames as PlatformRole[] };

      for (const { roomId } of memberships) {
        await this.moderation.forceDisconnect(actor, roomId, targetUserId, reason).catch((err) => {
          this.logger.debug(
            `Skipped video-room ejection for banned user ${targetUserId} in ${roomId}: ${(err as Error).message}`,
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
