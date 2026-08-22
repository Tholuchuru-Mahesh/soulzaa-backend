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
import { MODERATION_SENDER_NAME } from 'src/common/constants/moderation-sender.constant';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { RoomEndedEvent } from 'src/modules/audio-rooms/events/audio-room.events';
import { RoomClosedEvent } from 'src/modules/video-rooms/events/video-room.events';
import { UserGloballyBannedEvent, UserGloballyUnbannedEvent } from '../events/platform-ban.events';
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
  reportId?: string;
}

const BAN_DURATION_SECONDS = 86400;

export function banRedisKey(userId: string): string {
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
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
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
      reportId: input.reportId ?? null,
      expiresAt,
    });

    await this.redis.set(
      banRedisKey(input.targetUserId),
      JSON.stringify({ reason, expiresAt: expiresAt.toISOString() }),
      'EX',
      BAN_DURATION_SECONDS,
    );

    this.sockets.emitToUserEverywhere(input.targetUserId, 'platform-ban.account-banned', {
      sender: MODERATION_SENDER_NAME,
      reason,
      expiresAt: expiresAt.toISOString(),
    });

    // Awaited, not fire-and-forget: it fully self-catches (see below) so this
    // can never fail the ban, but the caller's HTTP response — and the
    // moderator client's own immediate UI refresh right after it — must not
    // be able to race ahead of the room actually being torn down. Otherwise
    // that refresh sometimes lands before the DB status flip / "closed"
    // broadcast commit and still shows the room as live.
    await this.endActiveRoomsFor(input.targetUserId);
    void this.bus.publish(
      new UserGloballyBannedEvent({
        targetUserId: input.targetUserId,
        moderatorId: input.moderatorId,
        reason,
      }),
    );
    // Deliberately NOT immediate, and deliberately last: the room-specific
    // ejections above (the synchronous kick the calling controller issues for
    // the room being investigated, plus this event's own room-type listeners
    // for every other room the target is active in) each notify the target's
    // client with a real "you were removed" event *before* disconnecting
    // their socket in that one namespace. A blunt, instant disconnect-
    // everywhere here would race ahead of all of that and win — killing the
    // connection before any of those targeted notifications can be delivered,
    // so the consumer app never visibly updates even though the ban itself
    // succeeded. This still eventually severs whatever those room-specific
    // kicks don't cover (DMs, notifications, calling), just after giving them
    // a head start.
    setTimeout(() => this.sockets.disconnectUserEverywhere(input.targetUserId), 3000);

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
   * back here would be circular. Awaited by the caller (so the room is
   * actually gone by the time the ban response comes back) but still
   * best-effort — every failure path here is caught internally, so it can
   * never fail the ban itself.
   *
   * A raw DB status flip alone is not enough: `ModerationService.forceDisconnect`
   * (the controller's synchronous "eject from the room under investigation"
   * step) deliberately no-ops against the room's own owner — it can only evict
   * a *member*, and an owner isn't tracked as one. So when the ban target owns
   * the room, this is the ONLY step that closes it, and everyone still
   * connected needs the same real-time teardown a normal end-room does
   * (socket "closed" broadcast, seat/stage clear) or they're left staring at a
   * room that looks live until an unrelated sweep eventually notices it's
   * empty. Publishing the same lifecycle events `AudioRoomsService`/
   * `VideoRoomLifecycleService` publish on a normal end reuses their existing,
   * already-wired listeners for this — no new coupling, since events (unlike
   * services) don't create a circular dependency.
   */
  private async endActiveRoomsFor(userId: string): Promise<void> {
    try {
      const [liveAudioRoom, liveVideoRooms] = await Promise.all([
        this.prisma.audioRoom.findFirst({
          where: { ownerId: userId, status: RoomStatus.LIVE },
          select: { id: true, createdAt: true },
        }),
        this.prisma.videoRoom.findMany({
          where: { ownerId: userId, status: VideoRoomStatus.LIVE },
          select: { id: true, createdAt: true },
        }),
      ]);

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

      const now = Date.now();
      if (liveAudioRoom) {
        await this.bus.publish(
          new RoomEndedEvent({
            roomId: liveAudioRoom.id,
            actorId: userId,
            ownerId: userId,
            durationSeconds: Math.floor((now - liveAudioRoom.createdAt.getTime()) / 1000),
          }),
        );
      }
      for (const room of liveVideoRooms) {
        await this.bus.publish(
          new RoomClosedEvent({
            roomId: room.id,
            actorId: userId,
            ownerId: userId,
            durationSeconds: Math.floor((now - room.createdAt.getTime()) / 1000),
          }),
        );
      }
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

  async getActiveBan(userId: string): Promise<{ reason: string; expiresAt: string } | null> {
    const raw = await this.redis.get(banRedisKey(userId));
    if (!raw) return null;
    return JSON.parse(raw) as { reason: string; expiresAt: string };
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

    void this.bus.publish(
      new UserGloballyUnbannedEvent({
        targetUserId: ban.targetUserId,
        moderatorId: adminId,
        reason: 'lifted',
      }),
    );

    const unbanPayload = {
      roomId: ban.originRoomId,
      targetUserId: ban.targetUserId,
      moderatorId: '00000000-0000-0000-0000-000000000000',
      reason: 'lifted',
      systemMessage: 'User ban was lifted by an administrator.',
    };

    this.sockets.emitToUserEverywhere(ban.targetUserId, 'room.unbanned', unbanPayload);
    this.sockets.emitToUserEverywhere(ban.targetUserId, 'userUnblacklisted', unbanPayload);
    this.sockets.emitToUserEverywhere(
      ban.targetUserId,
      'platform-moderation.user-unbanned',
      unbanPayload,
    );

    if (ban.originRoomId) {
      if (ban.roomType === PlatformRoomType.AUDIO_ROOM) {
        this.sockets.emitToNamespaceRoom(
          '/audio-room',
          ban.originRoomId,
          'room.unbanned',
          unbanPayload,
        );
      } else if (ban.roomType === PlatformRoomType.VIDEO_ROOM) {
        this.sockets.emitToNamespaceRoom(
          '/video-room',
          ban.originRoomId,
          'userUnblacklisted',
          unbanPayload,
        );
      }
    }

    return lifted;
  }

  async extendBan(adminId: string, banId: string, additionalHours: number): Promise<PlatformUserBan> {
    const ban = await this.repo.findById(banId);
    if (!ban) {
      throw new BadRequestException('Ban not found.');
    }
    if (ban.status !== 'ACTIVE') {
      throw new BadRequestException('This ban is not active.');
    }

    const newExpiresAt = new Date(ban.expiresAt.getTime() + additionalHours * 3600 * 1000);
    const extended = await this.repo.extend(banId, newExpiresAt);

    const ttlSeconds = Math.max(1, Math.floor((newExpiresAt.getTime() - Date.now()) / 1000));
    await this.redis.set(
      banRedisKey(ban.targetUserId),
      JSON.stringify({ reason: ban.reason, expiresAt: newExpiresAt.toISOString() }),
      'EX',
      ttlSeconds,
    );

    this.sockets.emitToUserEverywhere(ban.targetUserId, 'platform-ban.account-banned', {
      sender: MODERATION_SENDER_NAME,
      reason: ban.reason,
      expiresAt: newExpiresAt.toISOString(),
    });

    void this.audit.record({
      moderatorId: adminId,
      action: 'BAN_ISSUED',
      roomType: ban.roomType,
      roomId: ban.originRoomId,
      targetUserId: ban.targetUserId,
      reason: `Extended by ${additionalHours}h`,
    });

    return extended;
  }

  list(filter: ListPlatformBansFilter, skip: number, limit: number) {
    return this.repo.list(filter, skip, limit);
  }
}
