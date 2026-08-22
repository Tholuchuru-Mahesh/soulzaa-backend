// src/modules/platform-moderation/services/broad-ban.service.ts
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  BroadBan,
  PlatformRoomType,
  RoomStatus,
  VideoRoomStatus,
  LiveStreamStatus,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { MODERATION_SENDER_NAME } from 'src/common/constants/moderation-sender.constant';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { RoomEndedEvent } from 'src/modules/audio-rooms/events/audio-room.events';
import { RoomClosedEvent } from 'src/modules/video-rooms/events/video-room.events';
import { BroadBanRepository, type ListBroadBansFilter } from '../repositories/broad-ban.repository';
import { PlatformModerationAuditService } from './platform-moderation-audit.service';

export interface BanBroadInput {
  moderatorId: string;
  roomId: string;
  roomType: PlatformRoomType;
  reason: string;
  description?: string;
  proofUrl?: string;
}

const BROAD_BAN_DURATION_SECONDS = 86400;

export function broadBanCreationRedisKey(ownerId: string): string {
  return `broad-ban:creation:${ownerId}`;
}

/**
 * Bans one specific room ("Broad") and blocks its owner from creating a NEW
 * room while the ban is active. Fully independent of PlatformBanService /
 * PlatformUserBan — never reads or writes that table, and an active Broad
 * ban never blocks login or joining other rooms (only room creation, at the
 * three create call sites this service's assertNotBroadBanned is wired into).
 */
@Injectable()
export class BroadBanService {
  private readonly logger = new Logger(BroadBanService.name);

  constructor(
    private readonly repo: BroadBanRepository,
    private readonly audit: PlatformModerationAuditService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly sockets: SocketManager,
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async banBroad(input: BanBroadInput): Promise<BroadBan> {
    const reason = input.reason.trim();
    if (!reason) {
      throw new BadRequestException('A ban reason is required.');
    }

    const owner = await this.resolveRoomOwner(input.roomType, input.roomId);
    if (!owner) {
      throw new BadRequestException('Room not found.');
    }

    const expiresAt = new Date(Date.now() + BROAD_BAN_DURATION_SECONDS * 1000);
    const ban = await this.repo.create({
      roomId: input.roomId,
      roomType: input.roomType,
      ownerId: owner.ownerId,
      moderatorId: input.moderatorId,
      reason,
      description: input.description ?? null,
      proofUrl: input.proofUrl ?? null,
      expiresAt,
    });

    await this.redis.set(
      broadBanCreationRedisKey(owner.ownerId),
      JSON.stringify({ reason, expiresAt: expiresAt.toISOString(), roomId: input.roomId }),
      'EX',
      BROAD_BAN_DURATION_SECONDS,
    );

    await this.endRoomAndNotify(
      input.roomType,
      input.roomId,
      owner.ownerId,
      owner.createdAt,
      reason,
      expiresAt,
      input.description,
    );

    void this.audit.record({
      moderatorId: input.moderatorId,
      action: 'BAN_ISSUED',
      roomType: input.roomType,
      roomId: input.roomId,
      targetUserId: owner.ownerId,
      reason,
    });

    return ban;
  }

  async assertNotBroadBanned(ownerId: string): Promise<void> {
    const raw = await this.redis.get(broadBanCreationRedisKey(ownerId));
    if (!raw) return;
    const { reason, expiresAt } = JSON.parse(raw) as { reason: string; expiresAt: string };
    throw new ForbiddenException(`You cannot create a new Broad until ${expiresAt} for: ${reason}`);
  }

  async liftBroadBan(adminId: string, banId: string): Promise<BroadBan> {
    const ban = await this.repo.findById(banId);
    if (!ban) {
      throw new BadRequestException('Broad ban not found.');
    }
    if (ban.status !== 'ACTIVE') {
      return ban;
    }

    await this.redis.del(broadBanCreationRedisKey(ban.ownerId));
    const lifted = await this.repo.lift(banId, adminId);

    void this.audit.record({
      moderatorId: adminId,
      action: 'BAN_LIFTED',
      roomType: ban.roomType,
      roomId: ban.roomId,
      targetUserId: ban.ownerId,
    });

    return lifted;
  }

  async extendBroadBan(adminId: string, banId: string, additionalHours: number): Promise<BroadBan> {
    const ban = await this.repo.findById(banId);
    if (!ban) {
      throw new BadRequestException('Broad ban not found.');
    }
    if (ban.status !== 'ACTIVE') {
      throw new BadRequestException('This Broad ban is not active.');
    }

    const newExpiresAt = new Date(ban.expiresAt.getTime() + additionalHours * 3600 * 1000);
    const extended = await this.repo.extend(banId, newExpiresAt);

    const ttlSeconds = Math.max(1, Math.floor((newExpiresAt.getTime() - Date.now()) / 1000));
    await this.redis.set(
      broadBanCreationRedisKey(ban.ownerId),
      JSON.stringify({
        reason: ban.reason,
        expiresAt: newExpiresAt.toISOString(),
        roomId: ban.roomId,
      }),
      'EX',
      ttlSeconds,
    );

    this.sockets.emitToUserEverywhere(ban.ownerId, 'broad-ban.room-banned', {
      sender: MODERATION_SENDER_NAME,
      reason: ban.reason,
      expiresAt: newExpiresAt.toISOString(),
    });

    void this.audit.record({
      moderatorId: adminId,
      action: 'BAN_ISSUED',
      roomType: ban.roomType,
      roomId: ban.roomId,
      targetUserId: ban.ownerId,
      reason: `Extended by ${additionalHours}h`,
    });

    return extended;
  }

  list(filter: ListBroadBansFilter, skip: number, limit: number) {
    return this.repo.list(filter, skip, limit);
  }

  private async resolveRoomOwner(
    roomType: PlatformRoomType,
    roomId: string,
  ): Promise<{ ownerId: string; createdAt: Date } | null> {
    if (roomType === 'AUDIO_ROOM') {
      const room = await this.prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { ownerId: true, createdAt: true },
      });
      return room;
    }
    if (roomType === 'VIDEO_ROOM') {
      const room = await this.prisma.videoRoom.findUnique({
        where: { id: roomId },
        select: { ownerId: true, createdAt: true },
      });
      return room;
    }
    const stream = await this.prisma.liveStream.findUnique({
      where: { id: roomId },
      select: { streamerId: true, createdAt: true },
    });
    return stream ? { ownerId: stream.streamerId, createdAt: stream.createdAt } : null;
  }

  /**
   * Ends the one targeted room now and notifies everyone still connected to
   * it (including the owner — a room-wide broadcast reaches them too, unlike
   * a per-member eject which deliberately skips the owner; see
   * PlatformBanService.endActiveRoomsFor's identical note). Every failure
   * path is caught internally so it can never fail the ban itself. Live
   * Stream gets a status-only flip with no real-time broadcast, at parity
   * with PlatformBanService's existing handling for Live Stream (that gap
   * pre-dates this change and is not introduced by it).
   */
  private async endRoomAndNotify(
    roomType: PlatformRoomType,
    roomId: string,
    ownerId: string,
    createdAt: Date,
    reason: string,
    expiresAt: Date,
    description?: string,
  ): Promise<void> {
    const payload = {
      roomId,
      sender: MODERATION_SENDER_NAME,
      reason,
      description: description ?? null,
      expiresAt: expiresAt.toISOString(),
    };
    const durationSeconds = Math.floor((Date.now() - createdAt.getTime()) / 1000);

    try {
      if (roomType === 'AUDIO_ROOM') {
        await this.prisma.audioRoom.update({
          where: { id: roomId },
          data: { status: RoomStatus.OFFLINE, endedAt: new Date() },
        });
        this.sockets.emitToNamespaceRoom('/audio-room', roomId, 'broad-ban.room-banned', payload);
        await this.bus.publish(
          new RoomEndedEvent({ roomId, actorId: ownerId, ownerId, durationSeconds }),
        );
      } else if (roomType === 'VIDEO_ROOM') {
        await this.prisma.videoRoom.update({
          where: { id: roomId },
          data: { status: VideoRoomStatus.OFFLINE, endedAt: new Date() },
        });
        this.sockets.emitToNamespaceRoom('/video-room', roomId, 'broad-ban.room-banned', payload);
        await this.bus.publish(
          new RoomClosedEvent({ roomId, actorId: ownerId, ownerId, durationSeconds }),
        );
      } else {
        await this.prisma.liveStream.update({
          where: { id: roomId },
          data: { status: LiveStreamStatus.ENDED, endedAt: new Date() },
        });
      }
    } catch (e) {
      this.logger.error(`Failed to end broad-banned room ${roomId}: ${(e as Error).message}`);
    }
  }
}
