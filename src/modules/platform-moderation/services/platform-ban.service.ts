// src/modules/platform-moderation/services/platform-ban.service.ts
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  PlatformRoomType,
  PlatformUserBan,
  RoomStatus,
  VideoRoomStatus,
  LiveStreamStatus,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  PlatformBanRepository,
  type ListPlatformBansFilter,
} from '../repositories/platform-ban.repository';
import { PlatformModerationAuditService } from './platform-moderation-audit.service';

export interface BanUserInput {
  moderatorId: string;
  targetUserId: string;
  reason: string;
  roomType: PlatformRoomType;
  originRoomId: string;
}

const BAN_DURATION_SECONDS = 86400;

function banRedisKey(userId: string): string {
  return `platform-ban:user:${userId}`;
}

@Injectable()
export class PlatformBanService {
  private readonly logger = new Logger(PlatformBanService.name);

  constructor(
    private readonly repo: PlatformBanRepository,
    private readonly audit: PlatformModerationAuditService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly sockets: SocketManager,
    private readonly prisma: PrismaService,
  ) {}

  async banUser(input: BanUserInput): Promise<PlatformUserBan> {
    const reason = input.reason.trim();
    if (!reason) {
      throw new BadRequestException('A ban reason is required.');
    }

    const expiresAt = new Date(Date.now() + BAN_DURATION_SECONDS * 1000);
    const ban = await this.repo.create({
      targetUserId: input.targetUserId,
      moderatorId: input.moderatorId,
      reason,
      roomType: input.roomType,
      originRoomId: input.originRoomId,
      expiresAt,
    });

    await this.redis.set(
      banRedisKey(input.targetUserId),
      JSON.stringify({ reason, expiresAt: expiresAt.toISOString() }),
      'EX',
      BAN_DURATION_SECONDS,
    );

    this.sockets.disconnectUserEverywhere(input.targetUserId);
    void this.endActiveRoomsFor(input.targetUserId);

    void this.audit.record({
      moderatorId: input.moderatorId,
      action: 'BAN_ISSUED',
      roomType: input.roomType,
      roomId: input.originRoomId,
      targetUserId: input.targetUserId,
      reason,
    });

    return ban;
  }

  /**
   * A platform ban only blocks *future* create/join/start attempts (enforced
   * in each room module's own service) — it does nothing about a room the
   * target already has LIVE right now. Without this, that room keeps showing
   * as live in every room list until it happens to end some other way, even
   * though its owner is banned and can no longer manage it (their sockets were
   * just disconnected above). Direct Prisma `updateMany` rather than routing
   * through each room type's lifecycle service: those services all now depend
   * on `PlatformBanService` for the create/start ban check, so injecting them
   * back here would be circular. Best-effort and non-blocking (`void`'d by the
   * caller) — a failure here must never fail the ban itself.
   */
  private async endActiveRoomsFor(userId: string): Promise<void> {
    try {
      await Promise.all([
        this.prisma.audioRoom.updateMany({
          where: { ownerId: userId, status: RoomStatus.LIVE },
          data: { status: RoomStatus.OFFLINE, endedAt: new Date() },
        }),
        this.prisma.videoRoom.updateMany({
          where: { ownerId: userId, status: VideoRoomStatus.LIVE },
          data: { status: VideoRoomStatus.OFFLINE, endedAt: new Date() },
        }),
        this.prisma.liveStream.updateMany({
          where: { streamerId: userId, status: LiveStreamStatus.ACTIVE },
          data: { status: LiveStreamStatus.ENDED, endedAt: new Date() },
        }),
      ]);
    } catch (e) {
      this.logger.error(
        `Failed to end active rooms for banned user ${userId}: ${(e as Error).message}`,
      );
    }
  }

  async assertNotGloballyBanned(userId: string): Promise<void> {
    const raw = await this.redis.get(banRedisKey(userId));
    if (!raw) return;
    const { reason, expiresAt } = JSON.parse(raw) as { reason: string; expiresAt: string };
    throw new ForbiddenException(
      `You are banned from joining rooms until ${expiresAt} for: ${reason}`,
    );
  }

  async unbanUser(adminId: string, banId: string): Promise<PlatformUserBan> {
    const ban = await this.repo.findById(banId);
    if (!ban) {
      throw new BadRequestException('Ban not found.');
    }
    if (ban.status !== 'ACTIVE') {
      return ban;
    }

    await this.redis.del(banRedisKey(ban.targetUserId));
    const lifted = await this.repo.lift(banId, adminId);

    void this.audit.record({
      moderatorId: adminId,
      action: 'BAN_LIFTED',
      roomType: ban.roomType,
      roomId: ban.originRoomId,
      targetUserId: ban.targetUserId,
    });

    return lifted;
  }

  list(filter: ListPlatformBansFilter, skip: number, limit: number) {
    return this.repo.list(filter, skip, limit);
  }
}
